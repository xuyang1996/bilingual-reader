#!/usr/bin/env python3
"""Floating controls in isolated Chrome: real pointers, HTTP, storage and tabs.

Run a static server on port 8766 from the repository's parent first, then:
    python3 test/verify_floating.py --ext .
No user browser profile or real API keys are used.
"""
import argparse
import base64
import json
from pathlib import Path
import shutil
import subprocess
import tempfile
import time

from e2e import WS, find_free_port, wait_for_cdp
import testenv


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--ext', required=True)
    parser.add_argument('--chrome', default='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
    args = parser.parse_args()
    ext = Path(args.ext).resolve()
    profile = tempfile.mkdtemp(prefix='br-floating-')
    port = find_free_port()
    proc = subprocess.Popen([args.chrome, '--headless=new', '--disable-gpu', '--no-sandbox',
        '--window-size=1280,1000', f'--remote-debugging-port={port}', f'--user-data-dir={profile}',
        'about:blank'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    ws, mock = None, None
    results = []
    try:
        ws = WS(wait_for_cdp(port)['webSocketDebuggerUrl'])
        ext_id = ws.call('Extensions.loadUnpacked', {'path': str(ext)})['id']
        worker = testenv.find_service_worker(ws, ext_id)
        mock = testenv.MockLLM('slow-openai')
        testenv.write_engine(ws, worker, mock.engine(),
            {'lazy': False, 'incremental': False, 'pii': {'enabled': False}})

        def evaluate(expr, sid):
            r = ws.call('Runtime.evaluate', {'expression': expr, 'returnByValue': True, 'awaitPromise': True}, sid)
            if r.get('exceptionDetails'):
                raise RuntimeError(json.dumps(r['exceptionDetails'], ensure_ascii=False))
            return r.get('result', {}).get('value')

        def check(ok, name, detail=''):
            results.append(bool(ok))
            print(('PASS ' if ok else 'FAIL ') + name + (': ' + str(detail) if detail else ''), flush=True)

        def wait(fn, timeout=10):
            end = time.time() + timeout
            while time.time() < end:
                value = fn()
                if value:
                    return value
                time.sleep(.05)
            raise TimeoutError('condition did not become true')

        def tab(url):
            tid = ws.call('Target.createTarget', {'url': url})['targetId']
            sid = ws.call('Target.attachToTarget', {'targetId': tid, 'flatten': True})['sessionId']
            ws.call('Page.enable', {}, sid)
            return tid, sid

        # Upgrade an old free-position preference: preserve its height, ignore x.
        evaluate("chrome.storage.local.set({'imtl.floating.position':{x:0.15,y:0.55}})", worker)
        url = 'http://127.0.0.1:8766/bilingual-reader/demo/demo.html'
        target, page = tab(url)
        host = "document.getElementById('imtl-floating')"
        shadow = host + '.shadowRoot'
        wait(lambda: evaluate('!!(' + host + ')', page))
        check(evaluate("document.querySelectorAll('#imtl-floating').length === 1 && " + host + ".getAttribute('translate') === 'no'", page),
              'one isolated, nontranslatable floating widget appears by default')
        check(evaluate(shadow + ".querySelector('.panel').hidden", page), 'hover menu starts collapsed')
        check(evaluate('(function(){var r=' + host + '.getBoundingClientRect();return r.right<=innerWidth && r.left>innerWidth*.8;})()', page),
              'default position is on the right side of the viewport')
        check(evaluate('(function(){var r=' + host + '.getBoundingClientRect();return Math.abs(r.right-(innerWidth-8))<1 && Math.abs(r.top-(8+.55*(innerHeight-48)))<2;})()', page),
              'legacy horizontal placement is ignored while its height is preserved')

        def rect(selector='.trigger', sid=page):
            return evaluate('(function(){var r=' + shadow + '.querySelector(' + json.dumps(selector) +
                ').getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height};})()', sid)

        def mouse(kind, x, y, **extra):
            ws.call('Target.activateTarget', {'targetId': target})
            ws.call('Input.dispatchMouseEvent', dict(type=kind, x=x, y=y, **extra), page)

        def hover():
            r = rect()
            mouse('mouseMoved', r['x'] + r['width']/2, r['y'] + r['height']/2)
            try:
                wait(lambda: evaluate('!' + shadow + ".querySelector('.panel').hidden", page))
            except TimeoutError:
                print('Hover diagnostics:', evaluate('(function(){var r=' + shadow + ".querySelector('.trigger').getBoundingClientRect();var e=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return {width:innerWidth,height:innerHeight,x:r.x,y:r.y,hit:e&&e.outerHTML.slice(0,250),focus:document.hasFocus()};})()", page), flush=True)
                shot = ws.call('Page.captureScreenshot', {'format': 'png'}, page)
                Path('/tmp/bilingual-reader-floating-hover-debug.png').write_bytes(base64.b64decode(shot['data']))
                raise

        def click_trigger():
            r = rect()
            x, y = r['x'] + r['width']/2, r['y'] + r['height']/2
            mouse('mousePressed', x, y, button='left', clickCount=1)
            mouse('mouseReleased', x, y, button='left', clickCount=1)

        def click_action(action):
            hover()
            evaluate(shadow + '.querySelector(' + json.dumps('[data-action="' + action + '"]') + ').click()', page)

        def state():
            return evaluate("new Promise(resolve => chrome.tabs.query({},tabs=>{"
                "var t=tabs.find(t=>(t.url||'')===" + json.dumps(url) + ");"
                "chrome.tabs.sendMessage(t.id,{target:'imtl-content',action:'query'},resolve);}))", worker)

        check(rect()['width'] == 32 and rect()['height'] == 32, 'floating button is reduced to 32 by 32 pixels')
        opacity = 'Number(getComputedStyle(' + shadow + ".querySelector('.trigger')).opacity)"
        wait(lambda: abs(evaluate(opacity, page) - .5) < .01)
        check(True, 'idle button is half transparent')
        hover()
        wait(lambda: evaluate(opacity, page) > .99)
        check(True, 'hover restores full opacity')
        check(evaluate(shadow + ".querySelectorAll('[data-action]').length === 6", page),
              'hover exposes pause, retranslate, retry, restore, settings and close controls')
        mouse('mouseMoved', 0, 0)
        wait(lambda: abs(evaluate(opacity, page) - .5) < .01)
        check(True, 'leaving the widget restores half transparency')
        click_trigger()
        wait(lambda: state().get('done', 0) >= 3 and state().get('pending'))
        click_action('pause')
        paused = wait(lambda: (lambda s: s if s.get('paused') else None)(state()))
        check(evaluate(shadow + ".querySelector('[data-action=pause]').textContent === '继续'", page),
              'floating Pause changes to Continue')
        count = len(mock.requests()['requests'])
        time.sleep(.6)
        check(state().get('done') == paused['done'] and len(mock.requests()['requests']) == count,
              'floating Pause stops network scheduling and preserves current translations')
        shot = ws.call('Page.captureScreenshot', {'format': 'png', 'clip':
            {'x': 960, 'y': 300, 'width': 320, 'height': 550, 'scale': 1}}, page)
        Path('/tmp/bilingual-reader-floating-paused.png').write_bytes(base64.b64decode(shot['data']))
        mock.set_mode('openai-string')
        click_action('pause')
        completed = wait(lambda: (lambda s: s if not s.get('paused') and not s.get('pending') and s.get('done', 0) > 10 else None)(state()))
        check(not completed['failed'], 'floating Continue finishes translation without failures')
        check(all('上下拖动' not in json.dumps(r['body'], ensure_ascii=False) and
                  '关闭浮签' not in json.dumps(r['body'], ensure_ascii=False) for r in mock.requests()['requests']),
              'floating UI text is never sent for translation')

        before = len(mock.requests()['requests'])
        mock.set_mode('slow-openai')
        click_action('retranslate')
        wait(lambda: len(mock.requests()['requests']) > before)
        check(state().get('pending', 0) > 0, 'floating Retranslate starts a fresh translation session')
        click_action('pause')
        wait(lambda: state().get('paused'))
        mock.set_mode('openai-string')
        click_action('pause')
        wait(lambda: not state().get('pending') and state().get('done', 0) > 10)

        # Use real pointer capture and release; dragging must not synthesize a translation click.
        before_state = state()
        before_requests = len(mock.requests()['requests'])
        evaluate("window.__floatingPointer=[];window.__floatingErrors=[];"
            "['pointerdown','pointermove','pointerup','pointercancel'].forEach(k=>document.addEventListener(k,e=>"
            "window.__floatingPointer.push({type:e.type,x:e.clientX,y:e.clientY,id:e.pointerId,button:e.button,buttons:e.buttons,target:e.composedPath()[0].className}),true));"
            "window.addEventListener('error',e=>window.__floatingErrors.push(e.message));", page)
        r = rect()
        x, y = r['x']+r['width']/2, r['y']+r['height']/2
        mouse('mousePressed', x, y, button='left', clickCount=1)
        for i in range(1, 9):
            mouse('mouseMoved', x+(180-x)*i/8, y+(120-y)*i/8, buttons=1)
        mouse('mouseReleased', 180, 120, button='left', clickCount=1)
        time.sleep(.2)
        moved = rect()
        if abs(moved['x']-r['x']) >= 2:
            print('Pointer diagnostics:', evaluate('({events:__floatingPointer,errors:__floatingErrors,busy:' + shadow + ".querySelector('.trigger').getAttribute('aria-busy')})", page), flush=True)
        check(abs(moved['x']-r['x']) < 1 and abs(moved['y']-104) < 2,
              'diagonal dragging changes only height and stays docked on the right', moved)
        check(state().get('done') == before_state['done'] and len(mock.requests()['requests']) == before_requests,
              'dragging does not translate or restore the page')
        position = evaluate("chrome.storage.local.get('imtl.floating.position').then(d=>d['imtl.floating.position'])", worker)
        check(position and position['x'] == 1 and 0 <= position['y'] <= 1,
              'saved position fixes the right edge and remembers relative height')
        x, y = moved['x']+16, moved['y']+16
        mouse('mousePressed', x, y, button='left', clickCount=1)
        mouse('mouseMoved', 300, y, buttons=1)
        mouse('mouseReleased', 300, y, button='left', clickCount=1)
        check(abs(rect()['x']-moved['x']) < 1 and abs(rect()['y']-moved['y']) < 1 and state().get('done') == before_state['done'],
              'horizontal-only dragging neither moves the widget nor triggers translation')

        ws.call('Page.reload', {'ignoreCache': True}, page)
        wait(lambda: evaluate('!!(' + host + ')', page))
        check(abs(rect()['x']-moved['x']) < 2 and abs(rect()['y']-moved['y']) < 2,
              'placement survives a page reload')
        other_target, other = tab(url + '?floating=other')
        wait(lambda: evaluate('!!(' + host + ')', other))
        check(abs(rect(sid=other)['x']-moved['x']) < 2, 'placement is shared with a new webpage')
        evaluate("var f=document.createElement('iframe');f.id='floating-frame-test';f.src=" + json.dumps(url+'?floating=frame') + ";document.body.appendChild(f)", page)
        wait(lambda: evaluate("!!document.getElementById('floating-frame-test').contentDocument.querySelector('h1')", page))
        time.sleep(.2)
        check(evaluate("document.getElementById('floating-frame-test').contentDocument.querySelectorAll('#imtl-floating').length === 0", page),
              'iframes do not create duplicate floating controls')

        ws.call('Target.activateTarget', {'targetId': target})
        ws.call('Emulation.setDeviceMetricsOverride', {'width': 320, 'height': 420, 'deviceScaleFactor': 1, 'mobile': False}, page)
        wait(lambda: abs(rect()['x'] - (320 - 32 - 8)) < 2 and
             abs(rect()['y'] - (8 + position['y'] * (420 - 32 - 16))) < 2)
        hover()
        check(evaluate('(function(){var r=' + shadow + ".querySelector('.panel').getBoundingClientRect();return r.left>=0 && r.right<=innerWidth && r.top>=0 && r.bottom<=innerHeight;})()", page),
              'hover menu remains inside a small viewport')
        click_action('close')
        wait(lambda: evaluate('!(' + host + ')', page) and evaluate('!(' + host + ')', other))
        check(True, 'closing the widget hides it across open webpages')

        popup_target, popup = tab(f'chrome-extension://{ext_id}/src/popup/popup.html')
        wait(lambda: evaluate("document.getElementById('floatingToggle') && document.getElementById('floatingToggle').textContent === '显示网页浮签'", popup))
        evaluate("document.getElementById('floatingToggle').click()", popup)
        wait(lambda: evaluate('!!(' + host + ')', page) and evaluate('!!(' + host + ')', other))
        check(True, 'popup can re-enable floating controls on existing webpages without reload')
        check(evaluate("chrome.storage.local.get('imtl.floating.position').then(d=>JSON.stringify(d['imtl.floating.position']))", worker) == json.dumps(position, separators=(',', ':')),
              'hiding and showing does not overwrite the saved position')

        ws.call('Target.activateTarget', {'targetId': target})
        click_action('settings')
        def options_target():
            return next((t for t in ws.call('Target.getTargets').get('targetInfos', [])
                if t.get('url') == f'chrome-extension://{ext_id}/src/options/options.html'), None)
        options_info = wait(options_target)
        settings = ws.call('Target.attachToTarget', {'targetId': options_info['targetId'], 'flatten': True})['sessionId']
        check(True, 'floating Settings opens the extension settings through the background')
        wait(lambda: evaluate("!!document.getElementById('floatingEnabled')", settings))
        evaluate("var c=document.getElementById('floatingEnabled');c.checked=false;c.dispatchEvent(new Event('change'))", settings)
        wait(lambda: evaluate('!(' + host + ')', page) and evaluate('!(' + host + ')', other))
        ws.call('Page.reload', {'ignoreCache': True}, settings)
        wait(lambda: evaluate("document.readyState === 'complete' && !!document.getElementById('floatingEnabled') && !document.getElementById('floatingEnabled').checked", settings))
        check(True, 'settings switch persists and updates every open webpage')
        evaluate("var c=document.getElementById('floatingEnabled');c.checked=true;c.dispatchEvent(new Event('change'))", settings)
        wait(lambda: evaluate('!!(' + host + ')', page))
        check(True, 'settings switch restores the floating widget')

        # No configured engine: show an actionable message and open settings, without API calls.
        evaluate("chrome.storage.local.set({'imtl.config':{}})", worker)
        ws.call('Page.reload', {'ignoreCache': True}, page)
        wait(lambda: evaluate('!!(' + host + ')', page))
        calls = len(mock.requests()['requests'])
        click_trigger()
        wait(lambda: evaluate(shadow + ".querySelector('.status').textContent.includes('尚未配置')", page))
        check(len(mock.requests()['requests']) == calls, 'unconfigured widget guides to settings without sending translation requests')
        print(f'\n{sum(results)} passed / {len(results)-sum(results)} failed', flush=True)
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
