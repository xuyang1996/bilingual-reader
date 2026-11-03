#!/usr/bin/env python3
"""
Bilingual Reader — Chrome 应用商店素材生成

用真实 Chrome 加载扩展，抓取真实界面，生成商店所需的全部图片：

  · 1280×800  截图 ×5（商店最多 5 张，最少 1 张）
  · 440×280   小宣传图（可选）
  · 920×680   大宣传图（可选）
  · 1400×560  横幅宣传图（可选）

截图用**演示模式**（本地拼示例译文，不联网、不需要 API Key），
因此在任何机器上都能复现，不依赖任何厂商接口。

用法:
    python3 test/make_store_assets.py --ext . --out-dir store
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
from make_promo import flatten_to_rgb  # noqa: E402

CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"


def new_target(ws, url, width=1400, height=900, scale=1):
    tgt = ws.call("Target.createTarget", {"url": "about:blank"})["targetId"]
    sess = ws.call("Target.attachToTarget", {"targetId": tgt, "flatten": True})["sessionId"]
    ws.call("Page.enable", {}, sess)
    ws.call("Runtime.enable", {}, sess)
    ws.call("Emulation.setDeviceMetricsOverride",
            {"width": width, "height": height, "deviceScaleFactor": scale, "mobile": False}, sess)
    ws.call("Page.navigate", {"url": url}, sess)
    return tgt, sess


def ev(ws, sess, expr, await_promise=False):
    r = ws.call("Runtime.evaluate",
                {"expression": expr, "returnByValue": True, "awaitPromise": await_promise}, sess)
    if r.get("exceptionDetails"):
        return "EXC " + json.dumps(r["exceptionDetails"])[:300]
    return r.get("result", {}).get("value")


def compose(ws, sess, img_path, out_path, title, subtitle, w=1280, h=800):
    """把一张小图合成为 1280×800 的商店截图（浏览器里做，不用图像库）"""
    with open(img_path, "rb") as f:
        b64 = base64.b64encode(f.read()).decode()
    html = """<!DOCTYPE html><html><head><meta charset="utf-8"><style>
      * { box-sizing:border-box; }
      html,body { margin:0; width:%dpx; height:%dpx; overflow:hidden; }
      body { background:#0d1117; color:#e6edf3; display:flex; align-items:center;
             justify-content:center; gap:56px; padding:56px;
             font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC",sans-serif; }
      .txt { max-width:520px; }
      h1 { font-size:40px; margin:0 0 16px; line-height:1.2; }
      p { font-size:21px; line-height:1.6; color:#9198a1; margin:0; }
      .shot { border-radius:14px; overflow:hidden; box-shadow:0 24px 70px rgba(0,0,0,.55);
              border:1px solid #3d444d; background:#161b22; }
      .shot img { display:block; height:660px; }
    </style></head><body>
      <div class="txt"><h1>%s</h1><p>%s</p></div>
      <div class="shot"><img src="data:image/png;base64,%s"></div>
    </body></html>""" % (w, h, title, subtitle, b64)
    tmp = img_path + ".html"
    with open(tmp, "w", encoding="utf-8") as f:
        f.write(html)
    ws.call("Emulation.setDeviceMetricsOverride",
            {"width": w, "height": h, "deviceScaleFactor": 1, "mobile": False}, sess)
    ws.call("Page.navigate", {"url": "file://" + tmp}, sess)
    time.sleep(1.4)
    shoot(ws, sess, out_path, w, h)
    try:
        os.remove(tmp)
    except OSError:
        pass


def shoot(ws, sess, out_path, width=None, height=None, full=False):
    """截当前页面；商店要求 PNG 不带 alpha 通道，这里统一压平成 RGB"""
    opts = {"format": "png"}
    if width and height:
        opts["clip"] = {"x": 0, "y": 0, "width": width, "height": height, "scale": 1}
    opts["captureBeyondViewport"] = bool(full)
    shot = ws.call("Page.captureScreenshot", opts, sess)
    with open(out_path, "wb") as f:
        f.write(base64.b64decode(shot["data"]))
    w, h = flatten_to_rgb(out_path)
    print("  →", os.path.basename(out_path), "(%dx%d RGB 无 alpha)" % (w, h))


def shoot_element(ws, sess, selector, out_path, pad=0):
    """截某个元素（自动带上 padding）"""
    box = ev(ws, sess, """
      (function(){
        var el = document.querySelector(%s);
        if (!el) return null;
        var r = el.getBoundingClientRect();
        return JSON.stringify({x:r.x, y:r.y, width:r.width, height:r.height});
      })()
    """ % json.dumps(selector))
    if not box or not isinstance(box, str):
        print("  ! 找不到元素", selector)
        return False
    b = json.loads(box)
    shot = ws.call("Page.captureScreenshot", {
        "format": "png",
        "captureBeyondViewport": True,
        "clip": {
            "x": max(0, b["x"] - pad),
            "y": max(0, b["y"] - pad),
            "width": b["width"] + pad * 2,
            "height": b["height"] + pad * 2,
            "scale": 1
        }
    }, sess)
    with open(out_path, "wb") as f:
        f.write(base64.b64decode(shot["data"]))
    print("  →", os.path.basename(out_path))
    return True


# ---------------------------------------------------------------- 演示模式配置

DEMO_ENGINE = {
    "id": "demo", "name": "演示模式", "type": "ai", "format": "demo",
    "baseUrl": "", "path": "", "model": "演示模式", "key": "",
    "auth": "none", "queryKey": "key", "headers": {}, "extraBody": {},
    "responsePath": "", "systemRole": "", "temperature": 0.2,
    "maxTokens": 0, "timeout": 30, "batchSize": 1,
    "custom": False, "presetId": "demo", "seq": 1
}


def write_demo_config(ws, sw):
    """把扩展的配置写成「演示模式」，这样截图不需要任何 API Key"""
    payload = json.dumps(DEMO_ENGINE, ensure_ascii=False)
    ws.call("Runtime.evaluate", {
        "expression": (
            "new Promise(res=>{chrome.storage.local.set({'imtl.config':{"
            "engines:{demo:%s},engine:'demo',scenario:'general',autoScenario:true,"
            "customScenarios:{},cache:{enabled:false,maxAgeDay:30},"
            "generalRule:{translationMode:'dual',translationPosition:'after',"
            "sourceLang:'auto',targetLang:'zh-Hans',tags:[],excludeSelectors:[],"
            "translateChrome:false,thresholds:{},mainSelector:''},"
            "render:{targetWrapperTag:'font',fontSize:'inherit',lineHeight:'1.7',spacing:8},"
            "pii:{enabled:true,types:['EMAIL_ADDRESS','PHONE_NUMBER','CREDIT_CARD',"
            "'ID_NUMBER','IP_ADDRESS','URL','IBAN']},"
            "glossary:[],rules:[],lazy:true,incremental:true,autoTranslate:false}},"
            "()=>res('ok'));})") % payload,
        "returnByValue": True, "awaitPromise": True}, sw)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--chrome", default=CHROME)
    ap.add_argument("--ext", required=True)
    ap.add_argument("--out-dir", default="store")
    ap.add_argument("--demo-url", default="http://127.0.0.1:8766/bilingual-reader/demo/demo.html")
    args = ap.parse_args()

    ext = os.path.abspath(args.ext)
    out_dir = os.path.abspath(args.out_dir)
    os.makedirs(out_dir, exist_ok=True)

    port = find_free_port()
    profile = tempfile.mkdtemp(prefix="br-store-")
    proc = subprocess.Popen(
        [args.chrome, "--headless=new", "--disable-gpu", "--no-sandbox", "--hide-scrollbars",
         f"--remote-debugging-port={port}", f"--user-data-dir={profile}",
         "--window-size=1400,900", "about:blank"],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    ws = None
    try:
        ver = wait_for_cdp(port)
        ws = WS(ver["webSocketDebuggerUrl"])
        ext_id = ws.call("Extensions.loadUnpacked", {"path": ext}).get("id")
        print("扩展已加载，ID =", ext_id)
        base = f"chrome-extension://{ext_id}"

        # 等 service worker 起来，配置成演示模式
        sw = None
        for _ in range(30):
            for t in ws.call("Target.getTargets").get("targetInfos", []):
                if t.get("type") == "service_worker" and ext_id in t.get("url", ""):
                    sw = ws.call("Target.attachToTarget",
                                 {"targetId": t["targetId"], "flatten": True})["sessionId"]
                    break
            if sw:
                break
            time.sleep(0.5)
        if not sw:
            print("！未找到 service worker")
            return 1
        write_demo_config(ws, sw)
        time.sleep(1)

        # ---------- 截图 1：双语对照效果 ----------
        print("\n[1] 双语对照效果")
        page_tid, page = new_target(ws, args.demo_url, 1280, 800)
        time.sleep(2.5)
        ev(ws, page, """
          (function(){
            var i = document.getElementById('imtl-start');
            return i ? 'demo-has-start' : 'ok';
          })()
        """)
        # 触发翻译（内容脚本已在 demo 页跑起来，用页面内消息触发）
        ws.call("Runtime.evaluate", {
            "expression": (
                "new Promise(res=>{chrome.tabs.query({},ts=>{"
                "var t=(ts||[]).filter(x=>String(x.url||'').indexOf('demo.html')>=0)[0];"
                "if(!t)return res('no-tab');"
                "chrome.tabs.sendMessage(t.id,{target:'imtl-content',action:'start'},"
                "r=>res('sent'));});})"),
            "returnByValue": True, "awaitPromise": True}, sw)
        time.sleep(6)
        shoot(ws, page, os.path.join(out_dir, "screenshot-01-bilingual.png"))

        # ---------- 截图 2：设置页（翻译引擎） ----------
        print("\n[2] 设置页 · 翻译引擎")
        _, opt = new_target(ws, f"{base}/src/options/options.html", 1280, 800)
        time.sleep(2.5)
        ev(ws, opt, "document.querySelector('#sidebar button[data-panel=\"engines\"]').click(); 'ok'")
        time.sleep(0.6)
        shoot(ws, opt, os.path.join(out_dir, "screenshot-02-engines.png"))

        # ---------- 截图 3：设置页（翻译风格） ----------
        print("\n[3] 设置页 · 翻译风格")
        ev(ws, opt, "document.querySelector('#sidebar button[data-panel=\"style\"]').click(); 'ok'")
        time.sleep(0.6)
        shoot(ws, opt, os.path.join(out_dir, "screenshot-03-styles.png"))

        # ---------- 截图 4：popup ----------
        print("\n[4] 控制面板")
        # popup 只在加载时查一次页面状态。
        # 顺序必须是：先开 popup 标签页 → 再把「活动标签页」切回真实页面 →
        # 最后 reload popup。少了第二步，popup 会去问自己那个标签页。
        pop_tid, pop = new_target(ws, f"{base}/src/popup/popup.html", 420, 800)
        time.sleep(2)
        try:
            ws.call("Target.activateTarget", {"targetId": page_tid})
        except Exception:
            pass
        time.sleep(1.5)
        ws.call("Page.reload", {"ignoreCache": True}, pop)
        time.sleep(2.5)
        # 只截内容高度，别留一大片空白
        box = ev(ws, pop, """
          (function(){
            var el = document.body;
            var r = el.getBoundingClientRect();
            return JSON.stringify({x:r.x, y:r.y, width:r.width, height:r.height});
          })()
        """)
        b = json.loads(box) if isinstance(box, str) else {"x": 0, "y": 0, "width": 420, "height": 760}
        raw = os.path.join(out_dir, ".popup-raw.png")
        shot = ws.call("Page.captureScreenshot", {
            "format": "png", "captureBeyondViewport": True,
            "clip": {"x": b["x"], "y": b["y"], "width": b["width"],
                     "height": min(b["height"], 520), "scale": 1}
        }, pop)
        with open(raw, "wb") as f:
            f.write(base64.b64decode(shot["data"]))
        flatten_to_rgb(raw)
        print("  → .popup-raw.png")
        compose(ws, pop, raw,
                os.path.join(out_dir, "screenshot-04-popup.png"),
                "一个面板搞定",
                "显示模式、目标语言、翻译引擎、翻译风格、实时进度，"
                "全部在点开图标的那一瞬间就能切换。",
                1280, 800)
        try:
            os.remove(raw)
        except OSError:
            pass

        # ---------- 截图 5：设置页（翻译风格内联表单细节） ----------
        print("\n[5] 设置页 · 场景编辑")
        ev(ws, opt, "document.querySelector('#sidebar button[data-panel=\"style\"]').click(); 'ok'")
        time.sleep(0.4)
        ev(ws, opt, """
          (function(){
            var it = document.querySelector('#scenarioList [data-scenario="github"]');
            if (it) it.click();
            return 'ok';
          })()
        """)
        time.sleep(0.6)
        shoot(ws, opt, os.path.join(out_dir, "screenshot-05-scenario.png"))

        print("\n完成，素材在:", out_dir)
        return 0
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
    sys.exit(main())
