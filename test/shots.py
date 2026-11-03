#!/usr/bin/env python3
"""
Bilingual Reader — 扩展页面截图工具

把扩展装进真实 Chrome 后，截取设置页与控制面板。
依赖：只需 Python 3 标准库。

用法:
    python3 test/shots.py --ext . --out-dir docs
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


def new_target(ws, url, width=1200, height=1600, scale=2):
    """开一个标签页并返回 (targetId, sessionId)"""
    tgt = ws.call("Target.createTarget", {"url": "about:blank"})["targetId"]
    sess = ws.call("Target.attachToTarget", {"targetId": tgt, "flatten": True})["sessionId"]
    ws.call("Page.enable", {}, sess)
    ws.call("Runtime.enable", {}, sess)
    ws.call("Emulation.setDeviceMetricsOverride",
            {"width": width, "height": height, "deviceScaleFactor": scale, "mobile": False}, sess)
    ws.call("Page.navigate", {"url": url}, sess)
    return tgt, sess


def capture(ws, sess, out_path, wait_for=None, settle=2.5):
    time.sleep(settle)
    if wait_for:
        deadline = time.time() + 40
        while time.time() < deadline:
            r = ws.call("Runtime.evaluate", {"expression": wait_for, "returnByValue": True}, sess)
            if r.get("result", {}).get("value"):
                break
            time.sleep(0.5)
        time.sleep(0.6)
    shot = ws.call("Page.captureScreenshot",
                   {"format": "png", "captureBeyondViewport": True}, sess)
    with open(out_path, "wb") as f:
        f.write(base64.b64decode(shot["data"]))
    print("截图:", out_path)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--chrome", default="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome")
    ap.add_argument("--ext", required=True)
    ap.add_argument("--out-dir", default="docs")
    ap.add_argument("--base-url", default="http://127.0.0.1:8766/bilingual-reader")
    args = ap.parse_args()

    ext = os.path.abspath(args.ext)
    out_dir = os.path.abspath(args.out_dir)
    os.makedirs(out_dir, exist_ok=True)

    port = find_free_port()
    profile = tempfile.mkdtemp(prefix="br-shot-")
    proc = subprocess.Popen(
        [args.chrome, "--headless=new", "--disable-gpu", "--no-sandbox", "--hide-scrollbars",
         # 接口自测台在普通网页里跑，放开 CORS 才能真的发请求
         "--disable-web-security",
         f"--remote-debugging-port={port}", f"--user-data-dir={profile}",
         "--window-size=1200,1600", "about:blank"],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    ws = None
    try:
        ver = wait_for_cdp(port)
        ws = WS(ver["webSocketDebuggerUrl"])
        ext_id = ws.call("Extensions.loadUnpacked", {"path": ext}).get("id")
        print("扩展已加载，ID =", ext_id)
        base = f"chrome-extension://{ext_id}"

        # 先开一个真实网页 —— popup 要靠它才有「页面可通信」的状态
        page_tid, page_sess = new_target(ws, f"{args.base_url}/demo/demo.html")
        time.sleep(3)

        # 设置页：先造一个配好的引擎，截图才看得到真实形态
        _, opt_sess = new_target(ws, f"{base}/src/options/options.html")
        time.sleep(2.5)
        ws.call("Runtime.evaluate", {
            "expression": """
              (function(){
                var s = document.getElementById('enginePicker');
                s.value = '__new__:deepseek';
                s.dispatchEvent(new Event('change'));
                return true;
              })()
            """,
            "returnByValue": True}, opt_sess)
        time.sleep(0.8)
        ws.call("Runtime.evaluate", {
            "expression": """
              (function(){
                function set(f, v){
                  var el = document.querySelector('#engineForm [data-field="'+f+'"]');
                  if (!el) return;
                  el.value = v;
                  el.dispatchEvent(new Event('input', {bubbles:true}));
                }
                set('baseUrl','https://api.deepseek.com');
                set('model','deepseek-chat');
                set('key','sk-demo-0123456789abcdef');
                return true;
              })()
            """,
            "returnByValue": True}, opt_sess)
        time.sleep(0.8)
        capture(ws, opt_sess, os.path.join(out_dir, "screenshot-options.png"))

        # popup：先开标签页，再把「活动标签页」切回真实网页，
        # 否则 popup 会去问自己，状态里会显示「无法与页面通信」
        pop_tid, pop_sess = new_target(ws, f"{base}/src/popup/popup.html", 380, 700)
        time.sleep(2)
        try:
            ws.call("Target.activateTarget", {"targetId": page_tid})
        except Exception:
            pass
        time.sleep(1.5)
        # popup 只在加载时查一次页面状态，所以要重载一次让它问对页面
        ws.call("Page.reload", {"ignoreCache": True}, pop_sess)
        capture(ws, pop_sess, os.path.join(out_dir, "screenshot-popup.png"), settle=3)

        # 单元测试页：等断言跑完再截，避免拍到半途
        _, test_sess = new_target(ws, f"{args.base_url}/test/harness.html?autotest=1", 1200, 1500)
        capture(ws, test_sess, os.path.join(out_dir, "screenshot-tests.png"),
                wait_for="(function(){var s=document.getElementById('summary');"
                         "return !!(s&&/失败/.test(s.textContent)&&!/0 失败/.test(s.textContent));})()")

        # 大模型接口自测台（普通网页里跑需要放开 CORS）
        _, eng_sess = new_target(ws, f"{args.base_url}/test/engine.html", 960, 1400)
        capture(ws, eng_sess, os.path.join(out_dir, "screenshot-engine.png"))
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


if __name__ == "__main__":
    main()
