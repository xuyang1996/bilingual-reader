#!/usr/bin/env python3
"""
Bilingual Reader — Popup 行为验证

在真实扩展环境里驱动 popup 面板，验证：
  1. 没有配置任何可用引擎时，popup 强制提醒且翻译按钮禁用
  2. 配置好之后点击「翻译此页」，popup 不误报「操作失败」，状态显示已翻译
  3. 切换目标语言会真的重新翻译页面（目标语言确实进了请求）
  4. 切换翻译引擎会真的重新翻译页面
  5. popup 展示的状态与页面真实状态一致

用法：
    python3 test/verify_popup.py --ext . --url http://127.0.0.1:8766/bilingual-reader/demo/demo.html
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
from e2e import WS, find_free_port, wait_for_cdp  # noqa: E402
import testenv  # noqa: E402


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--chrome", default="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome")
    ap.add_argument("--ext", required=True)
    ap.add_argument("--url", required=True)
    ap.add_argument("--out", default="/tmp/bilingual-reader-popup.png")
    args = ap.parse_args()

    ext = os.path.abspath(args.ext)
    port = find_free_port()
    profile = tempfile.mkdtemp(prefix="br-popup-")
    proc = subprocess.Popen(
        [args.chrome, "--headless=new", "--disable-gpu", "--no-sandbox", "--hide-scrollbars",
         f"--remote-debugging-port={port}", f"--user-data-dir={profile}",
         "--window-size=1280,1600", "about:blank"],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

    ws = None
    mock = None
    failures = []

    def check(ok, label, detail=""):
        print(("  PASS  " if ok else "  FAIL  ") + label + (("  — " + str(detail)) if detail else ""))
        if not ok:
            failures.append(label)

    try:
        ver = wait_for_cdp(port)
        ws = WS(ver["webSocketDebuggerUrl"])
        ext_id = ws.call("Extensions.loadUnpacked", {"path": ext})["id"]
        print("扩展 ID:", ext_id)

        mock = testenv.MockLLM("openai-string")
        print("模拟大模型服务:", mock.base)

        sw = testenv.find_service_worker(ws, ext_id)
        if not sw:
            print("！未找到扩展 service worker")

        # 目标页面
        page_tid = ws.call("Target.createTarget", {"url": "about:blank"})["targetId"]
        page_sess = ws.call("Target.attachToTarget", {"targetId": page_tid, "flatten": True})["sessionId"]
        ws.call("Page.enable", {}, page_sess)
        ws.call("Runtime.enable", {}, page_sess)
        ws.call("Page.navigate", {"url": args.url}, page_sess)
        time.sleep(3)

        # popup 面板
        popup_tid = ws.call("Target.createTarget", {
            "url": f"chrome-extension://{ext_id}/src/popup/popup.html"
        })["targetId"]
        popup_sess = ws.call("Target.attachToTarget", {"targetId": popup_tid, "flatten": True})["sessionId"]
        ws.call("Runtime.enable", {}, popup_sess)
        # 把焦点交还给目标页：真实用户点工具栏图标时，活动标签页就是网页本身
        try:
            ws.call("Target.activateTarget", {"targetId": page_tid})
        except Exception:
            pass
        time.sleep(2)

        def pop(expr, sess=popup_sess):
            r = ws.call("Runtime.evaluate",
                        {"expression": expr, "returnByValue": True, "awaitPromise": True}, sess)
            if r.get("exceptionDetails"):
                return "EXCEPTION " + json.dumps(r["exceptionDetails"])[:300]
            return r.get("result", {}).get("value")

        def page_count():
            return pop("document.querySelectorAll('.imtl-translation').length", page_sess)

        def reload_popup():
            ws.call("Page.reload", {"ignoreCache": True}, popup_sess)
            time.sleep(2.5)

        # ---------- [1] 没配置引擎时的强制提醒 ----------
        print("\n[1] 未配置翻译引擎时的强制提醒")
        # 清空所有引擎的 Key，并把地址改成远端（本机地址是免 Key 的）
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
        reload_popup()
        notice_shown = pop("document.getElementById('notice').classList.contains('show')")
        btn_disabled = pop("document.getElementById('toggle').disabled")
        notice_text = pop("document.getElementById('notice').innerText")
        print("     横幅:", repr(notice_text)[:80], "| 按钮禁用:", btn_disabled)
        check(bool(notice_shown), "未配置引擎时弹出醒目提醒横幅", notice_text)
        check(bool(btn_disabled), "未配置引擎时「翻译此页」按钮禁用", btn_disabled)
        check("去配置" in str(notice_text), "提醒横幅里有「去配置」入口", notice_text)

        # ---------- [2] 配置好引擎后再翻译 ----------
        print("\n[2] 配置好引擎后点击「翻译此页」")
        testenv.write_engine(ws, sw, mock.engine())
        # 再加一个引擎，用来验证「切换引擎」
        ws.call("Runtime.evaluate", {
            "expression": (
                "new Promise(res=>{chrome.storage.local.get('imtl.config',d=>{"
                "var cfg=d['imtl.config']||{};cfg.engines=cfg.engines||{};"
                "cfg.engines['mock2']=Object.assign({},cfg.engines['mock'],"
                "{id:'mock2',name:'Mock 二号',model:'mock-model-2'});"
                "chrome.storage.local.set({'imtl.config':cfg},()=>res('ok'));});})"),
            "returnByValue": True, "awaitPromise": True}, sw)
        reload_popup()
        notice_after = pop("document.getElementById('notice').classList.contains('show')")
        check(not notice_after, "配好引擎后提醒横幅自动消失", notice_after)

        mock.reset()
        pop("document.getElementById('toggle').click()")
        time.sleep(6)
        status = pop("document.getElementById('status').innerText")
        btn = pop("document.getElementById('toggle').innerText")
        n1 = page_count()
        print("     popup 状态:", repr(status), "| 按钮:", repr(btn), "| 页面译文数:", n1)
        check("操作失败" not in str(status), "翻译成功后 popup 不误报「操作失败」", status)
        check(int(n1 or 0) > 0, "翻译成功后页面出现译文节点", n1)
        check("还原" in str(btn), "翻译后按钮切换为「还原本页」", btn)
        check("已译" in str(status), "popup 状态显示已译段数", status)

        # ---------- [3] 切换目标语言 ----------
        print("\n[3] 切换目标语言")
        before = page_count()
        sample_before = pop("(document.querySelector('.imtl-translation')||{}).textContent||''", page_sess)
        mock.reset()
        pop("var s=document.getElementById('lang'); s.value='ja'; s.dispatchEvent(new Event('change'));")
        time.sleep(8)
        status2 = pop("document.getElementById('status').innerText")
        n2 = page_count()
        sample_after = pop("(document.querySelector('.imtl-translation')||{}).textContent||''", page_sess)
        print("     popup 状态:", repr(status2), "| 页面译文数:", n2, "(切换前:", before, ")")
        print("     译文样本  前:", repr(sample_before[:40]), "→ 后:", repr(sample_after[:40]))
        check("操作失败" not in str(status2), "切换语言后 popup 不报失败", status2)
        check(int(n2 or 0) > 0, "切换语言后页面重新翻译", n2)
        # 目标语言是否真的进了请求（系统提示词里会出现目标语言名）
        reqs = mock.requests().get("requests", [])
        sysblob = json.dumps([r.get("body", {}) for r in reqs], ensure_ascii=False)
        check("日本語" in sysblob, "切换语言后目标语言真的进了请求", sysblob[:120])
        check("JA:" in str(sample_after) or sample_after != sample_before,
              "切换语言后译文内容确实变了", sample_after[:40])

        # ---------- [4] 切换翻译引擎 ----------
        print("\n[4] 切换翻译引擎")
        mock.reset()
        pop("var s=document.getElementById('engine'); s.value='mock2'; s.dispatchEvent(new Event('change'));")
        time.sleep(7)
        status3 = pop("document.getElementById('status').innerText")
        n3 = page_count()
        models = {r.get("body", {}).get("model") for r in mock.requests().get("requests", [])}
        print("     popup 状态:", repr(status3), "| 页面译文数:", n3, "| 收到的模型:", models)
        check("操作失败" not in str(status3), "切换引擎后 popup 不报失败", status3)
        check(int(n3 or 0) > 0, "切换引擎后页面重新翻译", n3)
        check("mock-model-2" in models, "切换引擎后确实用了新引擎的模型", models)

        # ---------- [5] 还原页面 ----------
        print("\n[5] 还原页面")
        pop("document.getElementById('toggle').click()")
        time.sleep(3)
        n4 = page_count()
        btn2 = pop("document.getElementById('toggle').innerText")
        print("     还原后译文数:", n4, "| 按钮:", repr(btn2))
        check(int(n4 or 0) == 0, "还原后页面无译文节点", n4)
        check("翻译此页" in str(btn2), "还原后按钮恢复为「翻译此页」", btn2)

        shot = ws.call("Page.captureScreenshot", {"format": "png"}, popup_sess)
        with open(args.out, "wb") as f:
            f.write(base64.b64decode(shot["data"]))
        print("\npopup 截图:", args.out)

        print("\n==== " + ("全部通过" if not failures else f"{len(failures)} 项失败: {failures}") + " ====")
        return 1 if failures else 0
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
