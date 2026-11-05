#!/usr/bin/env python3
"""Exercise Learn this sentence with real selection, an isolated Chrome and a mock model."""
import argparse
import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import subprocess
import tempfile
import threading
import time

from e2e import WS, find_free_port, wait_for_cdp
import testenv


FIRST = 'I ran into an old friend while I was waiting for the bus.'
PAGE = """<!doctype html><html lang="en"><meta charset="utf-8">
<style>main{max-width:730px;margin:48px auto;padding:0 16px;font:17px/1.6 system-ui}</style>
<main><p id="first">I ran into <em>an old friend</em> while I was waiting for the bus. We talked for a while.</p>
<p id="second">You can reach me at alice@example.com if you have questions.</p></main></html>"""


class Fixture(BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.end_headers()
        self.wfile.write(self.demo if self.path == '/demo.html' else PAGE.encode())

    def log_message(self, *args):
        pass


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--ext', default='.')
    parser.add_argument('--chrome', default='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
    args = parser.parse_args()
    Fixture.demo = (Path(args.ext) / 'demo' / 'demo.html').read_bytes()
    server = ThreadingHTTPServer(('127.0.0.1', 0), Fixture)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    url = f'http://127.0.0.1:{server.server_address[1]}/study.html'
    mock = testenv.MockLLM()
    port = find_free_port()
    ws = None
    with tempfile.TemporaryDirectory(prefix='br-study-') as profile:
        chrome = subprocess.Popen([args.chrome, '--headless=new', '--disable-gpu', '--no-sandbox',
            '--enable-unsafe-extension-debugging', '--window-size=1100,740',
            f'--remote-debugging-port={port}', f'--user-data-dir={profile}', 'about:blank'],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        try:
            ws = WS(wait_for_cdp(port)['webSocketDebuggerUrl'])
            ext = ws.call('Extensions.loadUnpacked', {'path': str(Path(args.ext).resolve())})['id']
            worker = testenv.find_service_worker(ws, ext)
            testenv.write_engine(ws, worker, mock.engine(systemPrompt='翻译测试提示词：简体中文'),
                {'lazy': False, 'incremental': True, 'pii': {'enabled': True}})
            target = ws.call('Target.createTarget', {'url': url})['targetId']
            page = ws.call('Target.attachToTarget', {'targetId': target, 'flatten': True})['sessionId']

            def ev(expr, sid=page):
                result = ws.call('Runtime.evaluate', {'expression': expr,
                    'awaitPromise': True, 'returnByValue': True}, sid)
                if result.get('exceptionDetails'):
                    raise RuntimeError(json.dumps(result['exceptionDetails'], ensure_ascii=False))
                return result['result'].get('value')

            def wait(predicate, description):
                end = time.monotonic() + 8
                while time.monotonic() < end:
                    if predicate():
                        return
                    time.sleep(.04)
                raise AssertionError(description)

            def action(name, filename='study.html'):
                return ev("chrome.tabs.query({}).then(tabs=>chrome.tabs.sendMessage("
                    "tabs.find(t=>t.url?.endsWith(" + json.dumps('/' + filename) + ")).id,"
                    "{target:'imtl-content',action:" + json.dumps(name) + "}))", worker)

            def visible(selector):
                return ev("document.querySelector('#imtl-study')?.shadowRoot.querySelector(" +
                    json.dumps(selector) + ')?.hidden === false')

            def select(selector, term=None):
                ev("""((selector,term)=>{var node=document.querySelector(selector),r=document.createRange();
                    if(term){var walker=document.createTreeWalker(node,NodeFilter.SHOW_TEXT),text;
                        while((text=walker.nextNode())&&!text.data.includes(term)){}
                        var i=text.data.indexOf(term);r.setStart(text,i);r.setEnd(text,i+term.length);
                    } else r.selectNodeContents(node);
                    getSelection().removeAllRanges();getSelection().addRange(r);
                })(""" + json.dumps(selector) + ',' + json.dumps(term) + ')')
                ev("new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))")

            def mouse(kind, x, y, **params):
                ws.call('Input.dispatchMouseEvent', dict(type=kind, x=x, y=y, **params), page)

            def click(selector):
                x, y = ev("(()=>{var r=document.querySelector('#imtl-study').shadowRoot.querySelector(" +
                    json.dumps(selector) + ").getBoundingClientRect();return [r.x+r.width/2,r.y+r.height/2]})()")
                mouse('mousePressed', x, y, button='left', buttons=1, clickCount=1)
                mouse('mouseReleased', x, y, button='left', clickCount=1)

            def requests():
                return mock.requests()['requests']

            def card(selector):
                return "document.querySelector('#imtl-study')?.shadowRoot.querySelector(" + json.dumps(selector) + ')'

            wait(lambda: ev("!!document.getElementById('imtl-floating')"), 'content script ready')
            select('#second')
            assert not visible('.trigger') and not requests(), 'no action on untranslated page'
            assert action('start')['ok']
            wait(lambda: ev("document.querySelectorAll('.imtl-translation').length === 2"), 'both paragraphs translated')
            mock.reset()
            select('#first .imtl-translation')
            assert not visible('.trigger'), 'translation must not show the action'
            select('#first .imtl-original')
            assert not visible('.trigger'), 'two sentences must not show the action'

            # Drag across inline markup using real input, then click the positioned button.
            ev("getSelection().removeAllRanges()")
            ws.call('Target.activateTarget', {'targetId': target})
            xy = ev("""(()=>{var o=document.querySelector('#first .imtl-original'),r=document.createRange();
                r.setStart(o.firstChild,0);r.setEnd(o.firstChild,1);var a=r.getBoundingClientRect();
                var n=o.lastChild,i=n.data.indexOf('.')+1;r.setStart(n,i-1);r.setEnd(n,i);
                var b=r.getBoundingClientRect();return [a.left+.2,a.y+a.height/2,b.right-.2,b.y+b.height/2]})()""")
            mouse('mousePressed', *xy[:2], button='left', buttons=1, clickCount=1)
            mouse('mouseMoved', *xy[2:], button='left', buttons=1)
            mouse('mouseReleased', *xy[2:], button='left', clickCount=1)
            actual = ev('getSelection().toString()')
            assert actual == FIRST, repr(actual)
            wait(lambda: visible('.trigger'), 'selection action should appear')
            assert not requests() and not visible('.panel'), 'selecting alone must not call the model'
            before = ev("document.getElementById('first').outerHTML")
            click('.trigger')
            wait(lambda: ev("!!document.querySelector('#imtl-study')?.shadowRoot.querySelector('.phrases')"), 'study response visible')
            assert ev("document.getElementById('first').outerHTML") == before, 'original and translation unchanged'
            assert ev('getSelection().toString()') == FIRST, 'native selection survives clicking'
            clear_position = """(()=>{var p=document.querySelector('#imtl-study')?.shadowRoot.querySelector('.panel').getBoundingClientRect();
                if(!p || !p.width || !getSelection().rangeCount) return false;
                var r=document.createRange();r.selectNodeContents(document.querySelector('#first .imtl-translation'));
                var safe=q=>p.right<=q.left||p.left>=q.right||p.bottom<=q.top||p.top>=q.bottom;
                return p.left>=0&&p.right<=innerWidth&&p.top>=0&&p.bottom<=innerHeight&&
                    safe(getSelection().getRangeAt(0).getBoundingClientRect())&&safe(r.getBoundingClientRect())})()"""
            assert ev(clear_position), 'card leaves the selected text and its translation visible'
            ws.call('Emulation.setDeviceMetricsOverride',
                {'width': 390, 'height': 620, 'deviceScaleFactor': 1, 'mobile': False}, page)
            wait(lambda: ev("innerWidth === 390 && " + clear_position), 'card repositions in a narrow viewport')
            ws.call('Emulation.clearDeviceMetricsOverride', {}, page)
            body = requests()[0]['body']
            assert len(requests()) == 1 and json.loads(body['messages'][-1]['content']) == {'sentence': FIRST}
            assert '初学者' in body['messages'][0]['content'] and '翻译测试提示词' not in json.dumps(body, ensure_ascii=False)
            print('PASS: real selection, explicit request, structured reply, and unobstructed bilingual text at both widths', flush=True)

            ev(card('.study-words summary') + '.click()')
            assert ev(card('.study-ipa') + ".textContent === '/ˈweɪtɪŋ/'")
            assert ev(card('.study-root') + ".textContent.includes('-ing')")
            ev(card('.study-save') + '.click()')
            wait(lambda: ev(card('.study-save') + ".getAttribute('aria-pressed') === 'true'"), 'sentence saved')
            ev(card('.study-words .study-save') + '.click()')
            wait(lambda: ev(card('.study-words .study-save') + ".getAttribute('aria-pressed') === 'true'"), 'nested word saved')
            ws.call('Input.dispatchKeyEvent', {'type': 'keyDown', 'key': 'Escape', 'code': 'Escape'}, page)
            assert not visible('.panel'), 'Escape closes the card'

            select('#first .imtl-original', 'waiting')
            assert ev(card('.trigger') + ".textContent === '查单词'") and len(requests()) == 1
            click('.trigger')
            wait(lambda: ev(card('.study-save') + "?.getAttribute('aria-pressed') === 'true'"),
                 'word lookup matches the saved entry from the sentence')
            assert ev(card('.study-word .explanation') + ".textContent.includes('wait')")
            assert json.loads(requests()[-1]['body']['messages'][-1]['content']) == {'word': 'waiting', 'sentence': FIRST}
            click('.close')
            request_count = len(requests())
            select('#second .imtl-original', 'alice')
            click('.trigger')
            wait(lambda: ev(card('.status') + ".textContent.includes('脱敏')"), 'no lookup for a masked email fragment')
            assert len(requests()) == request_count
            click('.close')
            print('PASS: contextual vocabulary, IPA, roots, and protection for selected PII fragments', flush=True)

            popup_url = f'chrome-extension://{ext}/src/popup/popup.html'
            popup_target = ws.call('Target.createTarget', {'url': popup_url})['targetId']
            popup = ws.call('Target.attachToTarget', {'targetId': popup_target, 'flatten': True})['sessionId']
            wait(lambda: ev("document.getElementById('ver')?.textContent.startsWith('v')", popup), 'popup ready')
            ev("document.getElementById('studyCollection').click()", popup)
            library = []

            def collection_tab():
                library[:] = [tab['targetId'] for tab in ws.call('Target.getTargets')['targetInfos']
                              if tab['url'] == f'chrome-extension://{ext}/src/study/collection.html']
                return library

            wait(collection_tab, 'popup opens the collection page')
            archive = ws.call('Target.attachToTarget', {'targetId': library[0], 'flatten': True})['sessionId']
            wait(lambda: ev("document.querySelectorAll('article').length === 2", archive), 'one word and one sentence are saved')
            ws.call('Page.reload', {}, archive)
            wait(lambda: ev("document.querySelectorAll('article').length === 2", archive), 'collection persists after reload')
            played = ev("""(() => {
                var played;
                var voices=[{lang:'en-US',localService:false},{lang:'en-GB',localService:true},{lang:'en-US',localService:true}];
                Object.defineProperty(window,'speechSynthesis',{value:{getVoices:()=>voices,
                    speak:u=>{played={word:u.text,lang:u.lang,local:u.voice.localService};u.onend();}}});
                Object.defineProperty(window,'SpeechSynthesisUtterance',{value:function(text){this.text=text;}});
                document.querySelector('#words .study-speak').click();
                return played;
            })()""", archive)
            assert played == {'word': 'waiting', 'lang': 'en-US', 'local': True}
            assert len(requests()) == request_count, 'review and pronunciation do not call the model'
            ev("document.querySelector('#words .study-save').click()", archive)
            wait(lambda: ev("document.getElementById('words').hidden", archive), 'removed word disappears from collection')
            ws.call('Target.activateTarget', {'targetId': target})
            print('PASS: popup opens persistent collection, local speech is selected, and removal works', flush=True)

            mock.set_mode('study-invalid')
            select('#second .imtl-original')
            click('.trigger')
            wait(lambda: visible('.retry'), 'malformed reply has a retry action')
            assert json.loads(requests()[-1]['body']['messages'][-1]['content']) == {
                'sentence': 'You can reach me at __PII_EMAIL_ADDRESS_1__ if you have questions.'}
            mock.set_mode('openai-string')
            click('.retry')
            wait(lambda: ev("document.querySelector('#imtl-study')?.shadowRoot.querySelector('.source')?.textContent.includes('alice@example.com')"),
                'retry restores the placeholder locally')
            click('.close')
            assert not visible('.panel') and ev("document.querySelectorAll('.imtl-translation').length") == 2
            print('PASS: Escape, isolated failure, retry, and existing privacy settings', flush=True)

            mock.set_mode('study-slow')
            mock.reset()
            select('#second .imtl-original')
            click('.trigger')
            wait(requests, 'slow model received the request')
            assert action('stop')['ok']
            time.sleep(1.1)
            assert not ev("document.querySelector('#imtl-study, .imtl-translation, .imtl-original')")
            print('PASS: restoring the page closes pending study and ignores any late reply', flush=True)

            mock.reset()
            testenv.write_engine(ws, worker, mock.engine(format='demo', auth='none'))
            ws.call('Page.navigate', {'url': url.replace('/study.html', '/demo.html')}, page)
            wait(lambda: ev("!!document.querySelector('#study-example') && !!document.querySelector('#imtl-floating')"),
                 'bundled demo page ready')
            assert action('start', 'demo.html')['ok']
            wait(lambda: ev("document.querySelector('#study-example .imtl-translation')?.textContent.includes('公交车')"),
                 'demo example has a bundled translation')
            ev("document.querySelector('#study-example').scrollIntoView({block:'center'})")
            select('#study-example .imtl-original')
            click('.trigger')
            wait(lambda: ev(card('.study-ipa') + "?.textContent.includes('weɪtɪŋ')"), 'offline sentence card')
            assert ev(card('.status') + ".textContent.includes('本地示例')")
            click('.close')
            select('#study-example .imtl-original', 'waiting')
            click('.trigger')
            wait(lambda: ev(card('.study-root') + "?.textContent.includes('-ing')"), 'offline word card')
            assert not requests(), 'store reviewer can verify the bundled example without contacting an API'
            print('PASS: bundled demo translates, explains the sentence and looks up the word offline', flush=True)
        finally:
            if ws:
                ws.sock.close()
            chrome.terminate()
            chrome.wait(timeout=10)
            mock.stop()
            server.shutdown()
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
