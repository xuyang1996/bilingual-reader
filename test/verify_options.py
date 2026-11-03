#!/usr/bin/env python3
"""
Bilingual Reader — 设置页往返验证

验证设置页真正「读得到、存得进、回显得出」：

  1. 左侧分类导航能切换面板
  2. 把阈值改成 999 / 777，点「保存全部」
  3. 从 chrome.storage.local 读回，确认落盘的是 999 / 777（而不是被默认值覆盖）
  4. 重新加载设置页，确认输入框仍显示 999 / 777
  5. 顺带确认「整页翻译」开关与正文容器选择器也能存回显
  6. 翻译风格场景：选一个、改提示词，存得进也回显得出
  7. 引擎没配好时横幅出现，配好后消失
  8. 设置的阈值必须真正影响真实页面的翻译结果

用法:
    python3 test/verify_options.py --ext . --out /tmp/shot-options.png
"""
import argparse
import base64
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from e2e import WS, wait_for_cdp, find_free_port  # noqa: E402
import testenv  # noqa: E402


class Checker:
    def __init__(self):
        self.passed = 0
        self.failed = 0

    def check(self, ok, label, detail=""):
        if ok:
            self.passed += 1
            print(f"  PASS  {label}" + (f"  — {detail}" if detail else ""))
        else:
            self.failed += 1
            print(f"  FAIL  {label}" + (f"  — {detail}" if detail else ""))
        return ok


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--chrome", default="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome")
    ap.add_argument("--ext", required=True)
    ap.add_argument("--out", default="/tmp/shot-options.png")
    args = ap.parse_args()

    ext = os.path.abspath(args.ext)
    c = Checker()

    port = find_free_port()
    profile = tempfile.mkdtemp(prefix="br-opt-")
    proc = subprocess.Popen(
        [args.chrome, "--headless=new", "--disable-gpu", "--no-sandbox", "--hide-scrollbars",
         f"--remote-debugging-port={port}", f"--user-data-dir={profile}",
         "--window-size=1200,1600", "about:blank"],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    ws = None
    mock = None
    try:
        ver = wait_for_cdp(port)
        ws = WS(ver["webSocketDebuggerUrl"])
        ext_id = ws.call("Extensions.loadUnpacked", {"path": ext}).get("id")
        print(f"扩展已加载，ID = {ext_id}\n")
        url = f"chrome-extension://{ext_id}/src/options/options.html"

        mock = testenv.MockLLM("openai-string")
        sw = testenv.find_service_worker(ws, ext_id)
        if sw:
            testenv.write_engine(ws, sw, mock.engine())

        tgt = ws.call("Target.createTarget", {"url": "about:blank"})["targetId"]
        sess = ws.call("Target.attachToTarget", {"targetId": tgt, "flatten": True})["sessionId"]
        ws.call("Page.enable", {}, sess)
        ws.call("Runtime.enable", {}, sess)

        def ev(expr, await_promise=False):
            r = ws.call("Runtime.evaluate",
                        {"expression": expr, "returnByValue": True,
                         "awaitPromise": await_promise}, sess)
            if r.get("exceptionDetails"):
                return "EXCEPTION " + json.dumps(r["exceptionDetails"])[:300]
            return r.get("result", {}).get("value")

        def reload():
            ws.call("Page.navigate", {"url": url}, sess)
            time.sleep(2.5)

        reload()

        # ── 1. 侧边栏导航 ──────────────────────────────────────
        print("【1】左侧分类导航")
        nav_items = json.loads(ev(
            "JSON.stringify(Array.prototype.map.call("
            "document.querySelectorAll('#sidebar button[data-panel]'),"
            "function(b){return b.getAttribute('data-panel');}))"))
        print("  导航项:", nav_items)
        c.check(len(nav_items) >= 7, "侧边栏有 7 个以上分类", f"{len(nav_items)} 项")
        c.check("engines" in nav_items and "style" in nav_items,
                "分类里有「翻译引擎」和「翻译风格」", nav_items)

        ev("document.querySelector('#sidebar button[data-panel=\"style\"]').click(); 'ok'")
        time.sleep(0.4)
        style_visible = ev("!document.querySelector('section.panel[data-panel=\"style\"]').hidden")
        engines_hidden = ev("document.querySelector('section.panel[data-panel=\"engines\"]').hidden")
        c.check(bool(style_visible), "点「翻译风格」后该面板显示", style_visible)
        c.check(bool(engines_hidden), "同一时刻只显示一个面板", engines_hidden)

        ev("document.querySelector('#sidebar button[data-panel=\"engines\"]').click(); 'ok'")
        time.sleep(0.4)
        back = ev("!document.querySelector('section.panel[data-panel=\"engines\"]').hidden")
        c.check(bool(back), "切回「翻译引擎」面板正常", back)

        # ── 2. 改成非默认值并保存 ──────────────────────────────
        print("\n【2】阈值与识别设置落盘")
        ev("""
          document.getElementById('paragraphMinTextCount').value = '999';
          document.getElementById('mainFrameMinTextCount').value = '777';
          document.getElementById('mainSelector').value = '#t-ul';
          document.getElementById('translateChrome').checked = true;
          'ok'
        """)
        ev("document.getElementById('saveAll').click(); 'clicked'")
        time.sleep(1.5)

        stored_raw = ev("new Promise(res=>{chrome.storage.local.get('imtl.config',"
                        "d=>res(JSON.stringify(d||{})));})", await_promise=True)
        stored = json.loads(stored_raw).get("imtl.config", {})
        th = stored.get("generalRule", {}).get("thresholds", {})
        print("  存储内容 thresholds =", json.dumps(th, ensure_ascii=False))

        c.check(th.get("paragraphMinTextCount") == 999,
                "保存后段落阈值落盘为 999",
                f"实际 {th.get('paragraphMinTextCount')}")
        c.check(th.get("mainFrameMinTextCount") == 777,
                "保存后整页阈值落盘为 777",
                f"实际 {th.get('mainFrameMinTextCount')}")
        c.check(stored.get("generalRule", {}).get("mainSelector") == "#t-ul",
                "正文容器选择器已落盘",
                f"实际 {stored.get('generalRule', {}).get('mainSelector')!r}")
        c.check(stored.get("generalRule", {}).get("translateChrome") is True,
                "整页翻译开关已落盘",
                f"实际 {stored.get('generalRule', {}).get('translateChrome')}")

        # ── 3. 重新加载，确认回显 ─────────────────────────────
        print("\n【3】重新加载后回显")
        reload()
        shown = json.loads(ev("""
          JSON.stringify({
            paragraph: document.getElementById('paragraphMinTextCount').value,
            mainFrame: document.getElementById('mainFrameMinTextCount').value,
            selector: document.getElementById('mainSelector').value,
            chrome: document.getElementById('translateChrome').checked
          })
        """))
        print("  重新加载后回显 =", json.dumps(shown, ensure_ascii=False))

        c.check(shown["paragraph"] == "999", "重新加载后段落阈值仍显示 999", f"实际 {shown['paragraph']}")
        c.check(shown["mainFrame"] == "777", "重新加载后整页阈值仍显示 777", f"实际 {shown['mainFrame']}")
        c.check(shown["selector"] == "#t-ul", "重新加载后正文容器选择器仍回显", f"实际 {shown['selector']!r}")
        c.check(shown["chrome"] is True, "重新加载后整页翻译开关仍回显", f"实际 {shown['chrome']}")

        # ── 4. 翻译风格场景 ───────────────────────────────────
        print("\n【4】翻译风格场景")
        ev("document.querySelector('#sidebar button[data-panel=\"style\"]').click(); 'ok'")
        time.sleep(0.4)
        scen_count = json.loads(ev(
            "JSON.stringify(Array.prototype.map.call("
            "document.querySelectorAll('#scenarioList [data-scenario]'),"
            "function(i){return i.getAttribute('data-scenario');}))"))
        print("  场景列表:", scen_count)
        c.check(len(scen_count) >= 14, "场景列表不少于 14 个", f"{len(scen_count)} 个")
        c.check("general" in scen_count and "github" in scen_count and "paper" in scen_count,
                "内置场景包含 通用 / GitHub / 学术论文", scen_count)

        # 选 GitHub 场景并改写提示词
        ev("""
          document.querySelector('#scenarioList [data-scenario="github"]').click();
          'ok'
        """)
        time.sleep(0.4)

        # 选中的场景下面要直接摊开它的表单
        inline = ev("""
          (function(){
            var on = document.querySelector('#scenarioList .scenario-item.on');
            var ed = document.getElementById('scenarioEditor');
            if (!on || !ed) return 'missing';
            return (ed.previousElementSibling === on && !ed.hidden) ? 'inline' : 'not-inline';
          })()
        """)
        print("  编辑器位置:", inline)
        c.check(inline == "inline", "选中场景的表单直接显示在那一项下面", inline)
        editor_in_list = ev("!!document.getElementById('scenarioList').contains("
                            "document.getElementById('scenarioEditor'))")
        c.check(bool(editor_in_list), "表单就插在场景列表里（紧跟选中项）", editor_in_list)
        no_details = ev("!document.getElementById('scenarioEditor').tagName || "
                         "document.getElementById('scenarioEditor').tagName !== 'DETAILS'")
        c.check(bool(no_details), "表单不再藏在折叠的 details 里")

        ev("""
          document.getElementById('scenarioPromptInput').value =
            'Translate like a senior engineer. Preserve code.';
          document.getElementById('scenarioDescInput').value = '我的 GitHub 风格';
          document.getElementById('scenarioSave').click();
          'ok'
        """)
        time.sleep(0.5)
        ev("document.getElementById('saveAll').click(); 'clicked'")
        time.sleep(1.5)

        stored_raw = ev("new Promise(res=>{chrome.storage.local.get('imtl.config',"
                        "d=>res(JSON.stringify(d||{})));})", await_promise=True)
        stored = json.loads(stored_raw).get("imtl.config", {})
        custom = stored.get("customScenarios", {})
        print("  自定义场景 =", json.dumps(custom, ensure_ascii=False)[:160])
        c.check(stored.get("scenario") == "github", "选中的场景已落盘", stored.get("scenario"))
        c.check("github" in custom, "改写后的场景存进了 customScenarios", list(custom.keys()))
        c.check("senior engineer" in json.dumps(custom, ensure_ascii=False),
                "改写后的提示词内容正确")

        reload()
        ev("document.querySelector('#sidebar button[data-panel=\"style\"]').click(); 'ok'")
        time.sleep(0.4)
        cur = ev("document.querySelector('#scenarioList .scenario-item.on')"
                 ".getAttribute('data-scenario')")
        prompt_val = ev("document.getElementById('scenarioPromptInput').value")
        c.check(cur == "github", "重新加载后仍选中 GitHub 场景", cur)
        c.check("senior engineer" in str(prompt_val), "重新加载后提示词回显", prompt_val[:60])
        edited_chip = ev("!!document.querySelector('#scenarioList .chip.edited')")
        c.check(bool(edited_chip), "被改写的场景有「已改写」标记", edited_chip)

        # 恢复内置提示词
        ev("document.getElementById('scenarioRestore').click(); 'ok'")
        time.sleep(0.4)
        ev("document.getElementById('saveAll').click(); 'clicked'")
        time.sleep(1.2)
        stored_raw = ev("new Promise(res=>{chrome.storage.local.get('imtl.config',"
                        "d=>res(JSON.stringify(d||{})));})", await_promise=True)
        stored = json.loads(stored_raw).get("imtl.config", {})
        c.check("github" not in stored.get("customScenarios", {}),
                "「恢复内置提示词」把改写删掉了",
                list(stored.get("customScenarios", {}).keys()))

        # ── 5. 翻译引擎：选择器 + 单表单 ──────────────────────
        print("\n【5】翻译引擎：选择器与配置表单")

        # 回到「一个引擎都没配」的初始状态
        if sw:
            ws.call("Runtime.evaluate", {
                "expression": (
                    "new Promise(res=>{chrome.storage.local.get('imtl.config',d=>{"
                    "var cfg=d['imtl.config']||{};cfg.engines={};cfg.engine='';"
                    "chrome.storage.local.set({'imtl.config':cfg},()=>res('ok'));});})"),
                "returnByValue": True, "awaitPromise": True}, sw)
        reload()

        c.check(not ev("!!document.getElementById('curEngine')"), "「当前引擎」下拉已去掉")
        c.check(not ev("!!document.getElementById('newEnginePreset')"), "「新增引擎」下拉已去掉")
        c.check(bool(ev("!!document.getElementById('enginePicker')")), "有「选择翻译引擎」下拉")
        c.check(int(ev("document.querySelectorAll('#engineForm .engine-card').length") or 0) == 0,
                "没选引擎时不显示任何引擎配置表单")
        c.check(bool(ev("!!document.querySelector('#engineForm .engine-empty')")),
                "没选引擎时表单区展示为空状态")

        # 选一个供应商预设 → 新建一个空白引擎
        ev("""
          (function(){
            var s = document.getElementById('enginePicker');
            s.value = '__new__:deepseek';
            s.dispatchEvent(new Event('change'));
            return true;
          })()
        """)
        time.sleep(0.6)
        cards1 = ev("document.querySelectorAll('#engineForm .engine-card').length")
        c.check(int(cards1 or 0) == 1, "选中供应商后只显示这一个引擎的表单", cards1)

        blank = json.loads(ev("""JSON.stringify({
            baseUrl: (document.querySelector('#engineForm [data-field="baseUrl"]')||{}).value,
            model: (document.querySelector('#engineForm [data-field="model"]')||{}).value,
            key: (document.querySelector('#engineForm [data-field="key"]')||{}).value
        })"""))
        c.check(blank["baseUrl"] == "" and blank["model"] == "" and blank["key"] == "",
                "没配置过的引擎表单展示为空", blank)

        # 填模型名 → 引擎名跟着变
        ev("""
          (function(){
            var el = document.querySelector('#engineForm [data-field="model"]');
            el.value = 'deepseek-chat';
            el.dispatchEvent(new Event('input', {bubbles:true}));
            return true;
          })()
        """)
        time.sleep(0.4)
        title = ev("(document.getElementById('engineFormTitle')||{}).textContent")
        c.check(title == "deepseek-chat", "引擎名直接取模型名", title)

        # 填地址 + Key → 状态变「已就绪」
        ev("""
          (function(){
            function set(f, v){
              var el = document.querySelector('#engineForm [data-field="'+f+'"]');
              el.value = v;
              el.dispatchEvent(new Event('input', {bubbles:true}));
            }
            set('baseUrl','https://api.deepseek.com');
            set('key','sk-test-123');
            return true;
          })()
        """)
        time.sleep(0.4)
        tag = ev("(document.querySelector('#engineForm .engine-head .tag')||{}).textContent")
        c.check("已就绪" in str(tag), "填完 Key 后标记为已就绪", tag)

        ev("document.getElementById('saveAll').click(); 'clicked'")
        time.sleep(1.5)
        stored_raw = ev("new Promise(res=>{chrome.storage.local.get('imtl.config',"
                        "d=>res(JSON.stringify(d||{})));})", await_promise=True)
        stored = json.loads(stored_raw).get("imtl.config", {})
        engines = stored.get("engines", {})
        print("  落盘引擎 =", json.dumps(engines, ensure_ascii=False)[:200])
        c.check(len(engines) == 1, "保存后只有一个引擎", list(engines.keys()))
        saved = list(engines.values())[0] if engines else {}
        c.check(saved.get("name") == "deepseek-chat", "落盘的引擎名 = 模型名", saved.get("name"))
        c.check(saved.get("baseUrl") == "https://api.deepseek.com",
                "落盘的 Base URL 正确", saved.get("baseUrl"))
        c.check(saved.get("key") == "sk-test-123", "落盘的 API Key 正确", saved.get("key"))
        c.check(stored.get("engine") == list(engines.keys())[0] if engines else False,
                "选中的引擎就是当前引擎", stored.get("engine"))

        # 下拉里显示的是模型名
        opt_text = ev("""
          (function(){
            var s = document.getElementById('enginePicker');
            for (var i=0;i<s.options.length;i++){
              if (s.options[i].value === 'deepseek')
                return s.options[i].textContent;
            }
            return '';
          })()
        """)
        c.check("deepseek-chat" in str(opt_text), "下拉里显示的是模型名", opt_text)

        # ── 6. 完全自定义引擎：可以改名，且不能重名 ────────────
        print("\n【6】完全自定义引擎的名字规则")
        ev("""
          (function(){
            var s = document.getElementById('enginePicker');
            s.value = '__new__:__custom__';
            s.dispatchEvent(new Event('change'));
            return true;
          })()
        """)
        time.sleep(0.6)
        has_name = ev("!!document.querySelector('#engineForm [data-field=\"name\"]')")
        c.check(bool(has_name), "完全自定义引擎有「引擎名称」输入框", has_name)

        ev("""
          (function(){
            function set(f, v){
              var el = document.querySelector('#engineForm [data-field="'+f+'"]');
              el.value = v;
              el.dispatchEvent(new Event('input', {bubbles:true}));
            }
            set('name','deepseek-chat');
            set('model','my-own-model');
            set('baseUrl','https://api.example.com/v1');
            set('key','sk-x');
            return true;
          })()
        """)
        time.sleep(0.4)
        ev("document.getElementById('saveAll').click(); 'clicked'")
        time.sleep(1.2)
        toast_text = ev("(document.getElementById('toast')||{}).textContent||''")
        print("  提示 =", repr(toast_text))
        c.check("重复" in str(toast_text), "引擎名与已有引擎重名时保存被拦下", toast_text)

        stored_raw = ev("new Promise(res=>{chrome.storage.local.get('imtl.config',"
                        "d=>res(JSON.stringify(d||{})));})", await_promise=True)
        stored2 = json.loads(stored_raw).get("imtl.config", {})
        c.check(len(stored2.get("engines", {})) == 1,
                "重名那次没有存进去", list(stored2.get("engines", {}).keys()))

        # 改成不重名的名字 → 存得进去
        ev("""
          (function(){
            var el = document.querySelector('#engineForm [data-field="name"]');
            el.value = '我的自建网关';
            el.dispatchEvent(new Event('input', {bubbles:true}));
            return true;
          })()
        """)
        time.sleep(0.3)
        ev("document.getElementById('saveAll').click(); 'clicked'")
        time.sleep(1.5)
        stored_raw = ev("new Promise(res=>{chrome.storage.local.get('imtl.config',"
                        "d=>res(JSON.stringify(d||{})));})", await_promise=True)
        stored3 = json.loads(stored_raw).get("imtl.config", {})
        names3 = sorted([v.get("name") for v in stored3.get("engines", {}).values()])
        print("  落盘引擎名 =", names3)
        c.check("我的自建网关" in names3, "自定义引擎名可以保存", names3)
        c.check(len(names3) == len(set(names3)), "所有引擎名互不重复", names3)

        # ── 7. 重新加载：已配置过的引擎能显示回自己的数据 ──────
        print("\n【7】重新加载后按引擎分别回显")
        reload()
        picked = ev("""
          (function(){
            var s = document.getElementById('enginePicker');
            for (var i=0;i<s.options.length;i++){
              if (s.options[i].value === 'deepseek') return s.options[i].value;
            }
            return '';
          })()
        """)
        ev("""
          (function(){
            var s = document.getElementById('enginePicker');
            s.value = %s;
            s.dispatchEvent(new Event('change'));
            return true;
          })()
        """ % json.dumps(picked))
        time.sleep(0.6)
        shown = json.loads(ev("""JSON.stringify({
            baseUrl: (document.querySelector('#engineForm [data-field="baseUrl"]')||{}).value,
            model: (document.querySelector('#engineForm [data-field="model"]')||{}).value
        })"""))
        print("  回显 =", json.dumps(shown, ensure_ascii=False))
        c.check(shown["model"] == "deepseek-chat" and shown["baseUrl"] == "https://api.deepseek.com",
                "切回已配置的引擎，显示的是它自己的数据", shown)

        # ── 8. 引擎未配置时的横幅 ──────────────────────────────
        print("\n【8】引擎未配置时的强制提醒")
        if sw:
            ws.call("Runtime.evaluate", {
                "expression": (
                    "new Promise(res=>{chrome.storage.local.get('imtl.config',d=>{"
                    "var cfg=d['imtl.config']||{};cfg.engines=cfg.engines||{};"
                    "Object.keys(cfg.engines).forEach(k=>{"
                    "  cfg.engines[k].key='';"
                    "  cfg.engines[k].baseUrl='https://api.example.com/v1';"
                    "  cfg.engines[k].auth='bearer';"
                    "});"
                    "chrome.storage.local.set({'imtl.config':cfg},()=>res('ok'));});})"),
                "returnByValue": True, "awaitPromise": True}, sw)
        reload()
        banner = ev("!document.getElementById('engineBanner').hidden")
        badge = ev("!document.getElementById('badgeEngines').hidden")
        c.check(bool(banner), "没配引擎时设置页出现提醒横幅", banner)
        c.check(bool(badge), "侧边栏「翻译引擎」有红点提醒", badge)

        # 配好引擎后横幅消失
        if sw:
            testenv.write_engine(ws, sw, mock.engine())
        reload()
        banner2 = ev("!document.getElementById('engineBanner').hidden")
        badge2 = ev("!document.getElementById('badgeEngines').hidden")
        c.check(not banner2, "配好引擎后横幅消失", banner2)
        c.check(not badge2, "配好引擎后红点消失", badge2)
        # 光看 hidden 属性不够：CSS 的 display 会盖掉它，要看真实渲染
        banner_shown = ev(
            "getComputedStyle(document.getElementById('engineBanner')).display !== 'none'")
        c.check(not banner_shown, "配好引擎后横幅真的看不见了（不是只改了 hidden 属性）", banner_shown)

        # ── 9. 设置的阈值必须真正影响真实页面的翻译结果 ────────
        print("\n【9】阈值真正影响真实页面")
        demo_url = ("http://127.0.0.1:8766/bilingual-reader/demo/demo.html")

        def translate_demo():
            """在 demo 页触发翻译，返回译文节点数"""
            if not sw:
                return -1
            dtgt = ws.call("Target.createTarget", {"url": "about:blank"})["targetId"]
            dsess = ws.call("Target.attachToTarget",
                            {"targetId": dtgt, "flatten": True})["sessionId"]
            ws.call("Page.enable", {}, dsess)
            ws.call("Runtime.enable", {}, dsess)
            ws.call("Page.navigate", {"url": demo_url}, dsess)
            time.sleep(3)
            testenv.start_translation(ws, sw, "demo.html")
            time.sleep(6)
            n = ws.call("Runtime.evaluate", {
                "expression": "document.querySelectorAll('.imtl-translation').length",
                "returnByValue": True}, dsess).get("result", {}).get("value")
            try:
                ws.call("Target.closeTarget", {"targetId": dtgt})
            except Exception:
                pass
            return n

        n_high = translate_demo()
        print(f"  阈值=999 时 demo 页译文节点数 = {n_high}")
        c.check(n_high == 0,
                "段落阈值调到 999 后，真实页面一个字都不该翻",
                f"实际译出 {n_high} 段")

        # 恢复默认阈值，再翻一次，确认恢复照常工作
        ev("""
          document.getElementById('paragraphMinTextCount').value = '2';
          document.getElementById('mainFrameMinTextCount').value = '50';
          document.getElementById('mainSelector').value = '';
          document.getElementById('translateChrome').checked = false;
          document.getElementById('saveAll').click();
          'ok'
        """)
        time.sleep(1.5)
        n_low = translate_demo()
        print(f"  阈值恢复默认后 demo 页译文节点数 = {n_low}")
        c.check(n_low > 10,
                "阈值恢复默认后，真实页面应照常翻译",
                f"实际译出 {n_low} 段")

        # ── 10. 截图：设置页（翻译引擎面板） ───────────────────
        ev("document.querySelector('#sidebar button[data-panel=\"engines\"]').click(); 'ok'")
        time.sleep(0.5)
        shot = ws.call("Page.captureScreenshot", {"format": "png", "captureBeyondViewport": True}, sess)
        with open(args.out, "wb") as f:
            f.write(base64.b64decode(shot["data"]))
        print("\n  截图:", args.out)

        print(f"\n==== {'全部通过' if c.failed == 0 else '存在失败'} "
              f"（{c.passed} 通过 / {c.failed} 失败）====")
        return 1 if c.failed else 0
    finally:
        try:
            if ws:
                ws.sock.close()
        except Exception:
            pass
        proc.terminate()
        try:
            proc.wait(timeout=8)
        except Exception:
            proc.kill()
        shutil.rmtree(profile, ignore_errors=True)
        if mock:
            mock.stop()


if __name__ == "__main__":
    sys.exit(main())
