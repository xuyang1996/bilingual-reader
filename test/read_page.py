#!/usr/bin/env python3
"""用 CDP 读取页面里的元素文本（用于自动化校验测试结果）。"""
import json
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from e2e import WS, wait_for_cdp, find_free_port  # noqa: E402
import subprocess
import tempfile
import shutil
import urllib.request


def main():
    url = sys.argv[1]
    selector = sys.argv[2] if len(sys.argv) > 2 else "body"
    wait = float(sys.argv[3]) if len(sys.argv) > 3 else 6.0
    chrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
    extra = []
    if os.environ.get("IMTL_NO_WEB_SECURITY") == "1":
        extra.append("--disable-web-security")

    port = find_free_port()
    profile = tempfile.mkdtemp(prefix="br-read-")
    proc = subprocess.Popen(
        [chrome, "--headless=new", "--disable-gpu", "--no-sandbox", "--hide-scrollbars",
         f"--remote-debugging-port={port}", f"--user-data-dir={profile}",
         "--window-size=1200,1500"] + extra + ["about:blank"],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    ws = None
    try:
        ver = wait_for_cdp(port)
        ws = WS(ver["webSocketDebuggerUrl"])
        tid = ws.call("Target.createTarget", {"url": "about:blank"})["targetId"]
        sess = ws.call("Target.attachToTarget", {"targetId": tid, "flatten": True})["sessionId"]
        ws.call("Page.enable", {}, sess)
        ws.call("Runtime.enable", {}, sess)
        ws.call("Page.navigate", {"url": url}, sess)
        time.sleep(wait)
        r = ws.call("Runtime.evaluate", {
            "expression": f"(document.querySelector({json.dumps(selector)})||{{}}).innerText",
            "returnByValue": True}, sess)
        print(r.get("result", {}).get("value", ""))
    finally:
        try:
            if ws:
                ws.sock.close()
        except Exception:
            pass
        proc.terminate()
        try:
            proc.wait(timeout=6)
        except Exception:
            proc.kill()
        shutil.rmtree(profile, ignore_errors=True)


if __name__ == "__main__":
    main()
