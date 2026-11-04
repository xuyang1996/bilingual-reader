#!/usr/bin/env python3
"""Fault-injection and extension-message regression tests, in an isolated Chrome profile.

Uses only Python's standard library. No user profile, credentials, or real API calls.
Run: python3 test/verify_reliability.py --ext .
"""
import argparse
import json
import pathlib
import re
import shutil
import subprocess
import tempfile
import time

from e2e import WS, find_free_port, wait_for_cdp
import testenv


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--ext', required=True)
    parser.add_argument('--source-ref', help='Run only fault injection against a Git revision, to verify the regression')
    parser.add_argument('--chrome', default='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
    args = parser.parse_args()
    ext = pathlib.Path(args.ext).resolve()
    profile = tempfile.mkdtemp(prefix='br-reliability-')
    port = find_free_port()
    proc = subprocess.Popen([args.chrome, '--headless=new', '--disable-gpu', '--no-sandbox',
        '--hide-scrollbars', '--window-size=1280,2000', f'--remote-debugging-port={port}',
        f'--user-data-dir={profile}', 'about:blank'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    ws, mock = None, None
    results = []

    def check(ok, name, detail=''):
        results.append(bool(ok))
        print(('PASS ' if ok else 'FAIL ') + name + (': ' + str(detail) if detail else ''), flush=True)

    try:
        ws = WS(wait_for_cdp(port)['webSocketDebuggerUrl'])
        target = ws.call('Target.createTarget', {'url': 'about:blank'})['targetId']
        session = ws.call('Target.attachToTarget', {'targetId': target, 'flatten': True})['sessionId']

        def evaluate(expression, sid=session):
            result = ws.call('Runtime.evaluate', {'expression': expression, 'returnByValue': True, 'awaitPromise': True}, sid)
            if result.get('exceptionDetails'):
                raise RuntimeError(json.dumps(result['exceptionDetails'], ensure_ascii=False))
            return result.get('result', {}).get('value')

        for source in ['shared/defaults.js', 'shared/utils.js', 'shared/prompts.js',
                       'core/rules.js', 'core/segment.js', 'core/render.js', 'core/pii.js',
                       'core/glossary.js', 'core/pipeline.js', 'background/engines.js']:
            code = subprocess.check_output(['git', 'show',
                args.source_ref + ':src/' + source], cwd=ext, text=True) if args.source_ref else (ext / 'src' / source).read_text()
            evaluate(code)
        for result in evaluate((pathlib.Path(__file__).parent / 'reliability.js').read_text()):
            check(result['ok'], result['name'], result.get('error', ''))
        if args.source_ref:
            print(f'\n{sum(results)} passed / {len(results) - sum(results)} failed', flush=True)
            return 0 if all(results) else 1

        for result in evaluate((pathlib.Path(__file__).parent / 'controls.js').read_text()):
            check(result['ok'], result['name'], result.get('error', ''))

        ws.call('Page.enable', {}, session)
        ws.call('Page.navigate', {'url': 'http://127.0.0.1:8766/bilingual-reader/test/harness.html'}, session)
        time.sleep(.5)
        evaluate("document.getElementById('runAll').click()")
        for _ in range(100):
            summary = evaluate("document.getElementById('summary').textContent")
            if '共 67' in summary:
                break
            time.sleep(.1)
        check('67 通过 / 0 失败' in summary, 'existing DOM regression harness', summary)

        # Exercise the actual worker -> content -> popup error path, then repair
        # the model and retry only failed paragraphs using the same page controller.
        ext_id = ws.call('Extensions.loadUnpacked', {'path': str(ext)})['id']
        worker = testenv.find_service_worker(ws, ext_id)
        mock = testenv.MockLLM('retired-model')
        testenv.write_engine(ws, worker, mock.engine(model='MiniMax-Text-01'),
            {'lazy': False, 'incremental': False, 'pii': {'enabled': False}})
        ws.call('Page.enable', {}, session)
        ws.call('Page.navigate', {'url': 'http://127.0.0.1:8766/bilingual-reader/demo/demo.html'}, session)
        time.sleep(2)

        def action(name):
            return evaluate("new Promise(resolve => chrome.tabs.query({}, tabs => {"
                "var tab = tabs.find(t => (t.url || '').includes('/demo/demo.html'));"
                "chrome.tabs.sendMessage(tab.id, {target:'imtl-content',action:" + json.dumps(name) + "}, resolve);}))", worker)

        action('start')
        for _ in range(60):
            state = action('query')
            if state.get('failed') and not state.get('pending'):
                break
            time.sleep(.1)
        check(state.get('failed', 0) > 10 and 'MiniMax-Text-01' in (state.get('error') or ''),
              'actual extension exposes retired-model error and affected paragraph count', state)
        check(evaluate("document.querySelectorAll('.imtl-translation').length") == 0,
              'actual extension never inserts original text as a fake translation')
        check(len(mock.requests()['requests']) == 1, 'actual extension stops requesting a retired model',
              len(mock.requests()['requests']))

        popup_target = ws.call('Target.createTarget', {'url': f'chrome-extension://{ext_id}/src/popup/popup.html'})['targetId']
        popup = ws.call('Target.attachToTarget', {'targetId': popup_target, 'flatten': True})['sessionId']
        ws.call('Target.activateTarget', {'targetId': target})
        time.sleep(.5)
        # Feed the real state through the popup's own progress listener.
        evaluate("chrome.runtime.sendMessage({type:'IMT_STATE_REPORT',payload:" + json.dumps(state) + "})", worker)
        time.sleep(.2)
        check(evaluate("document.getElementById('status').textContent.includes('MiniMax-Text-01') && !document.getElementById('retry').hidden", popup),
              'popup displays the real model error and retry button')

        mock.set_mode('openai-string')
        testenv.write_engine(ws, worker, mock.engine(model='fixed-model'), {'lazy': False})
        action('retry')
        for _ in range(100):
            state = action('query')
            if state.get('done', 0) > 10 and not state.get('pending') and mock.requests()['requests']:
                break
            time.sleep(.1)
        check(state.get('done', 0) > 10 and state.get('failed') == 0 and not state.get('error'),
              'actual extension repairs the same page after changing model, without a page reload', state)
        evaluate("document.getElementById('retry').click()", popup)
        time.sleep(.2)
        check(evaluate("document.getElementById('retry').hidden", popup), 'popup hides retry after recovery')

        # A model change must miss the old model's cached results.
        config = {'cache': {'enabled': True}, 'lazy': False}
        testenv.write_engine(ws, worker, mock.engine(model='cache-model-one'), config)
        def translate():
            return evaluate("chrome.runtime.sendMessage({type:'IMT_TRANSLATE',texts:['Cache regression paragraph'],engineId:'mock',targetLang:'zh-Hans'})", popup)
        first = translate()
        count = len(mock.requests()['requests'])
        second = translate()
        check(first.get('ok') and second.get('ok') and len(mock.requests()['requests']) == count,
              'unchanged engine still uses cache')
        testenv.write_engine(ws, worker, mock.engine(model='cache-model-two'), config)
        third = translate()
        check(third.get('ok') and len(mock.requests()['requests']) == count + 1,
              'changing model invalidates old-model translation cache')

        mock.set_mode('slow-openai')
        testenv.write_engine(ws, worker, mock.engine(model='controls-model'),
            {'cache': {'enabled': True}, 'lazy': False, 'incremental': False})
        action('start')
        for _ in range(100):
            state = action('query')
            if state.get('done', 0) >= 3 and state.get('pending'):
                break
            time.sleep(.05)
        evaluate("document.getElementById('pause').click()", popup)
        time.sleep(.1)
        state = action('query')
        check(state.get('paused') and state.get('done', 0) >= 3 and not state.get('pending'),
              'popup pauses real HTTP translation while preserving completed paragraphs', state)
        paused_done = state.get('done')
        paused_requests = len(mock.requests()['requests'])
        time.sleep(.6)
        after = action('query')
        check(after.get('done') == paused_done and not after.get('failed') and len(mock.requests()['requests']) == paused_requests,
              'paused extension sends no further HTTP requests or late DOM updates')

        ws.call('Target.closeTarget', {'targetId': popup_target})
        popup_target = ws.call('Target.createTarget', {'url': f'chrome-extension://{ext_id}/src/popup/popup.html'})['targetId']
        popup = ws.call('Target.attachToTarget', {'targetId': popup_target, 'flatten': True})['sessionId']
        ws.call('Target.activateTarget', {'targetId': target})
        time.sleep(.5)
        check(evaluate("document.getElementById('pause').textContent === '继续' && !document.getElementById('pause').disabled", popup),
              'closing and reopening popup preserves pause state and Continue button')
        mock.set_mode('openai-string')
        evaluate("document.getElementById('pause').click()", popup)
        for _ in range(100):
            state = action('query')
            if not state.get('pending') and not state.get('paused'):
                break
            time.sleep(.05)
        check(state.get('done') == state.get('total') and not state.get('failed'),
              'Continue completes the same page with correct counts', state)
        check(evaluate("document.querySelectorAll('.imtl-original .imtl-original, .imtl-translation .imtl-translation').length") == 0,
              'resuming does not nest original or translation wrappers')

        # Capture the first source paragraph from the existing DOM, then restart
        # from a scrolled page whose translations are already cached.
        first_original = evaluate("document.querySelector('.imtl-original').textContent.trim()")
        mock.reset()
        evaluate("window.scrollTo(0, document.body.scrollHeight)")
        evaluate("document.getElementById('retranslate').click()", popup)
        for _ in range(100):
            state = action('query')
            if state.get('done', 0) > 10 and not state.get('pending') and mock.requests()['requests']:
                break
            time.sleep(.05)
        requests = mock.requests()['requests']
        check(state.get('done') == state.get('total') and not state.get('failed') and len(requests) == state.get('total'),
              'Retranslate bypasses existing cache and translates every paragraph again', len(requests))
        check(requests and re.sub(r'\s+', ' ', requests[0]['body']['messages'][-1]['content']).strip() == re.sub(r'\s+', ' ', first_original) and evaluate('window.scrollY') == 0,
              'Retranslate starts at the first paragraph and returns to page top')

        mock.set_mode('slow-openai')
        evaluate("document.getElementById('retranslate').click()", popup)
        time.sleep(.1)
        evaluate("document.getElementById('pause').click()", popup)
        time.sleep(.1)
        check(action('query').get('paused'), 'retranslation itself supports pause')
        mock.set_mode('openai-string')
        evaluate("document.getElementById('retranslate').click()", popup)
        for _ in range(100):
            state = action('query')
            if state.get('done', 0) > 10 and not state.get('pending'):
                break
            time.sleep(.05)
        check(not state.get('paused') and not state.get('failed') and state.get('done') == state.get('total'),
              'Retranslate while paused creates a fresh session without stale work')

        print(f'\n{sum(results)} passed / {len(results) - sum(results)} failed', flush=True)
        return 0 if all(results) else 1
    finally:
        if ws:
            ws.sock.close()
        proc.terminate()
        try:
            proc.wait(timeout=8)
        except subprocess.TimeoutExpired:
            proc.kill()
        shutil.rmtree(profile, ignore_errors=True)
        if mock:
            mock.stop()


if __name__ == '__main__':
    raise SystemExit(main())
