#!/usr/bin/env python3
"""
Bilingual Reader — 「接入大模型 API」设置界面截图

把扩展装进真实 Chrome，打开设置页，用真实交互添加几个供应商预设，
再把「高级参数」展开，最后只截引擎配置区。

用法:
    python3 test/shot_ai.py --ext . --out docs/screenshot-ai-config.png
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


def eval_js(ws, sess, expr):
    r = ws.call("Runtime.evaluate", {"expression": expr, "returnByValue": True}, sess)
    return r.get("result", {}).get("value")


def shoot_element(ws, sess, selector, out_path, pad=16):
    """按元素外接矩形截图（比整页截图更能看清细节）"""
    box = eval_js(ws, sess, """
      (function(){
        var el = document.querySelector(%s);
        if (!el) return null;
        el.scrollIntoView({block:'start'});
        var r = el.getBoundingClientRect();
        return {x: r.x, y: r.y, w: r.width, h: r.height,
                sx: r.x + window.scrollX, sy: r.y + window.scrollY};
      })()
    """ % json.dumps(selector))
    if not box:
        print("  ! 找不到元素", selector)
        return
    time.sleep(0.4)
    # 重新量一次，scrollIntoView 之后位置可能变了
    box = eval_js(ws, sess, """
      (function(){
        var el = document.querySelector(%s);
        var r = el.getBoundingClientRect();
        return {x: r.x + window.scrollX, y: r.y + window.scrollY, w: r.width, h: r.height};
      })()
    """ % json.dumps(selector))
    clip = {
        "x": max(0, box["x"] - pad),
        "y": max(0, box["y"] - pad),
        "width": box["w"] + pad * 2,
        "height": box["h"] + pad * 2,
        "scale": 2,
    }
    shot = ws.call("Page.captureScreenshot",
                   {"format": "png", "captureBeyondViewport": True, "clip": clip}, sess)
    with open(out_path, "wb") as f:
        f.write(base64.b64decode(shot["data"]))
    print("截图:", out_path, "->", clip)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--chrome", default="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome")
    ap.add_argument("--ext", required=True)
    ap.add_argument("--out", default="docs/screenshot-ai-config.png")
    args = ap.parse_args()

    ext = os.path.abspath(args.ext)
    out_path = os.path.abspath(args.out)
    os.makedirs(os.path.dirname(out_path), exist_ok=True)

    port = find_free_port()
    profile = tempfile.mkdtemp(prefix="br-shotai-")
    proc = subprocess.Popen(
        [args.chrome, "--headless=new", "--disable-gpu", "--no-sandbox", "--hide-scrollbars",
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

        tgt = ws.call("Target.createTarget", {"url": "about:blank"})["targetId"]
        sess = ws.call("Target.attachToTarget", {"targetId": tgt, "flatten": True})["sessionId"]
        ws.call("Page.enable", {}, sess)
        ws.call("Runtime.enable", {}, sess)
        ws.call("Emulation.setDeviceMetricsOverride",
                {"width": 1200, "height": 1600, "deviceScaleFactor": 2, "mobile": False}, sess)
        ws.call("Page.navigate", {"url": f"{base}/src/options/options.html"}, sess)
        time.sleep(3)

        # 用真实交互新建一个引擎（DeepSeek），再填上地址 / 模型 / Key
        eval_js(ws, sess, """
          (function(){
            var s = document.getElementById('enginePicker');
            s.value = '__new__:deepseek';
            s.dispatchEvent(new Event('change'));
            return true;
          })()
        """)
        time.sleep(0.6)

        eval_js(ws, sess, """
          (function(){
            function set(f, v){
              var el = document.querySelector('#engineForm [data-field="'+f+'"]');
              if (!el) return;
              el.value = v;
              el.dispatchEvent(new Event('input', {bubbles:true}));
            }
            set('baseUrl', 'https://api.deepseek.com');
            set('model', 'deepseek-chat');
            set('key', 'sk-demo-0123456789abcdef');
            var d = document.querySelector('#engineForm details');
            if (d) d.open = true;
            return true;
          })()
        """)
        time.sleep(0.8)

        cards = eval_js(ws, sess, "document.querySelectorAll('#engineForm .engine-card').length")
        names = eval_js(ws, sess, """
          Array.prototype.map.call(
            document.querySelectorAll('#engineForm .engine-card .engine-head h3'),
            function (h) { return h.textContent; }).join(' | ')
        """)
        print("引擎表单数:", cards, "→", names)

        shoot_element(ws, sess, "#engineForm", out_path)

        # 「翻译风格」面板：场景列表
        eval_js(ws, sess, """
          (function(){
            document.querySelector('#sidebar button[data-panel="style"]').click();
            return true;
          })()
        """)
        time.sleep(0.6)
        shoot_element(ws, sess, "section.panel[data-panel=\"style\"]",
                      out_path.replace(".png", "-style.png"), pad=0)
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
