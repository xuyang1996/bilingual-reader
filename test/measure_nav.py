#!/usr/bin/env python3
"""
Bilingual Reader — 真实站点「导航 / 侧栏排除」实测

在真实 Chrome（CDP Extensions.loadUnpacked）里加载扩展，打开真实站点并翻译整页，
然后回到页面上下文统计：

  selected   被判定为「翻译单元」的块数          → data-imtl-state / data-imtl-error
  leaked     其中落在站点框架（导航/侧栏/页脚）里的块数   ← 核心指标，应接近 0
  content    落在正文区域的块数                  → 覆盖度
  coverage   正文可译段落被选中的比例             → 防止过滤过度把正文也杀掉

为什么这个指标不依赖网络：
  管线在懒翻译模式下会给**全部**被选中的块打上 data-imtl-state="pending"
  （schedule() 里 usable.forEach → markPending），这一步发生在任何网络请求之前。
  所以翻译引擎是否可用都不影响选段结果的测量。

口径说明：
  leakSame   用扩展自己的框架定义（标签 aside/nav/footer + role + class/id 词元）
  leakBroad  用更宽的独立定义（额外含 header、ul/ol 菜单容器、class 含 nav/side/menu/breadcrumb）
             用来交叉验证：leakBroad 允许有少量 header 品牌名，这是设计取舍，不是缺陷

用法:
    python3 test/measure_nav.py --ext . \
        --site https://news.ycombinator.com \
        --site https://en.wikipedia.org/wiki/Web_browser

依赖：只需 Python 3 标准库。
"""
import argparse
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


# --------------------------------------------------------------------------
# 页面内探针：在主世界执行，统计选段 / 泄漏 / 覆盖度
# --------------------------------------------------------------------------
PROBE = r"""
(function(){
  // ── 地标定义（独立于扩展实现，作为「真值」基准）────────────────────────
  // 语义地标：nav / aside / footer + 对应的 ARIA role + aria-label 面包屑
  var LM_TAGS  = { NAV:1, ASIDE:1, FOOTER:1 };
  var LM_ROLES = { navigation:1, complementary:1, contentinfo:1, banner:1,
                   menu:1, menubar:1, search:1, toolbar:1, tablist:1 };
  // 注意：HEADER 不计入地标——文章标题区常用 <header>，那是正文不是站点框架

  var all = document.querySelectorAll('*');
  var lmSet = new Set();
  for (var i=0;i<all.length;i++){
    var el = all[i], tag = el.tagName.toUpperCase();
    var role = el.getAttribute ? el.getAttribute('role') : null;
    var label = el.getAttribute ? (el.getAttribute('aria-label')||'') : '';
    if (LM_TAGS[tag] || (role && LM_ROLES[role]) || /breadcrumb/i.test(label)) lmSet.add(el);
  }

  function inSet(el, set){
    var p = el;
    while (p && p.nodeType === 1){
      if (set.has(p)) return true;
      p = p.parentElement;
    }
    return false;
  }

  // 链接密集容器（纯内容特征）：导航/目录/标签云
  // 占页面文字太多时它是「内容本身」（HN 那类站点），不算框架
  var pageText = (document.body ? document.body.textContent : '').replace(/\s+/g,'').length;
  function isLinkDense(el){
    var links = el.querySelectorAll('a');
    if (!links || links.length < 4) return false;
    var lc = 0;
    for (var i=0;i<links.length;i++) lc += (links[i].textContent||'').replace(/\s+/g,'').length;
    var total = (el.textContent||'').replace(/\s+/g,'').length;
    if (!total) return false;
    if (lc/total < 0.55 || lc/links.length > 32) return false;
    if (pageText && total > pageText * 0.25) return false;   // 它就是内容本身
    return true;
  }
  var denseSet = new Set();
  for (var j=0;j<all.length;j++){
    if (isLinkDense(all[j])) denseSet.add(all[j]);
  }

  var selected = Array.prototype.slice.call(
    document.querySelectorAll('[data-imtl-state], [data-imtl-error]'));
  var translated = Array.prototype.slice.call(
    document.querySelectorAll('.imtl-translation'));

  function txt(el){ return (el.textContent||'').replace(/\s+/g,' ').trim().slice(0,60); }

  // 主指标：落在语义地标内的块 —— 完全独立于扩展实现的启发式
  var leakLandmark = selected.filter(function(e){ return inSet(e, lmSet); });

  // 次指标：落在链接密集容器内的块，再按「是否纯链接」细分
  var inDense = selected.filter(function(e){ return inSet(e, denseSet); });
  function linkRatio(el){
    var links = el.querySelectorAll('a');
    var lt = 0;
    for (var i=0;i<links.length;i++) lt += (links[i].textContent||'').replace(/\s+/g,'').length;
    var t = (el.textContent||'').replace(/\s+/g,'').length;
    return t ? lt/t : 0;
  }
  var inDenseLinkish = inDense.filter(function(e){ return linkRatio(e) >= 0.8; });

  // 正文可译段落：段落型标签 + 足够长度 + 不在地标内
  var PARA = 'p, li, td, th, h1, h2, h3, h4, h5, h6, blockquote, figcaption, dd, dt';
  var paras = Array.prototype.slice.call(document.querySelectorAll(PARA));
  var contentParas = paras.filter(function(p){
    if (inSet(p, lmSet)) return false;
    var t = (p.textContent||'').replace(/\s+/g,' ').trim();
    return t.length >= 20;
  });
  var contentParasSelected = contentParas.filter(function(p){
    return p.hasAttribute('data-imtl-state') || p.hasAttribute('data-imtl-error') ||
           p.querySelector('[data-imtl-state]') || p.querySelector('.imtl-translation');
  });

  return JSON.stringify({
    url: location.href,
    title: document.title,
    readyState: document.readyState,
    htmlLen: document.documentElement.outerHTML.length,
    bodyChars: (document.body ? document.body.innerText.length : 0),
    bodyHead: (document.body ? (document.body.innerText||'').replace(/\s+/g,' ').trim().slice(0,120) : ''),
    selected: selected.length,
    translated: translated.length,
    errors: document.querySelectorAll('.imtl-error').length,
    leakLandmark: leakLandmark.length,
    inDense: inDense.length,
    inDenseLinkish: inDenseLinkish.length,
    leakTotal: leakLandmark.length,
    leakSamples: leakLandmark.slice(0,8).map(txt),
    denseLinkishSamples: inDenseLinkish.slice(0,8).map(txt),
    landmarkCount: lmSet.size,
    contentParas: contentParas.length,
    coverage: contentParas.length
      ? Math.round(contentParasSelected.length / contentParas.length * 1000) / 10
      : null,
    mode: document.documentElement.getAttribute('data-imtl-mode')
  });
})()
"""
# 逐段滚动，触发 IntersectionObserver，让懒翻译覆盖整页
SCROLL = r"""
(async function(){
  var step = Math.round(window.innerHeight * 0.8);
  var max = Math.max(document.body ? document.body.scrollHeight : 0, 1);
  for (var y = 0; y <= max; y += step){
    window.scrollTo(0, y);
    await new Promise(function(r){ setTimeout(r, 90); });
  }
  window.scrollTo(0, 0);
  await new Promise(function(r){ setTimeout(r, 200); });
  return 'ok';
})()
"""


def wait_for_content(ws, sess, min_chars=300, timeout=25):
    """等页面正文稳定下来（内容不再增长），避免把「页面还没到」当成识别失败。"""
    t0 = time.time()
    last = -1
    stable = 0
    while time.time() - t0 < timeout:
        r = ws.call("Runtime.evaluate",
                    {"expression": "(document.body?document.body.innerText.length:0)",
                     "returnByValue": True}, sess)
        v = r.get("result", {}).get("value") or 0
        if v == last and v >= min_chars:
            stable += 1
            if stable >= 2:
                return v
        else:
            stable = 0
        last = v
        time.sleep(0.6)
    return last


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--chrome", default="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome")
    ap.add_argument("--ext", required=True, help="扩展目录（含 manifest.json）")
    ap.add_argument("--site", action="append", default=[], help="要测的网址，可重复")
    ap.add_argument("--wait", type=int, default=8, help="翻译后等待秒数")
    ap.add_argument("--json", default="", help="把结果写到这个 JSON 文件")
    args = ap.parse_args()

    ext = os.path.abspath(args.ext)
    if not os.path.exists(os.path.join(ext, "manifest.json")):
        sys.exit(f"不是扩展目录（缺 manifest.json）：{ext}")
    sites = args.site or [
        "https://news.ycombinator.com",
        "https://en.wikipedia.org/wiki/Web_browser",
        "https://developer.mozilla.org/en-US/docs/Web/HTML",
    ]

    port = find_free_port()
    profile = tempfile.mkdtemp(prefix="br-nav-")
    proc = subprocess.Popen(
        [args.chrome, "--headless=new", "--disable-gpu", "--no-sandbox", "--hide-scrollbars",
         f"--remote-debugging-port={port}", f"--user-data-dir={profile}",
         "--window-size=1280,2000", "about:blank"],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

    ws = None
    results = []
    mock = None
    try:
        ver = wait_for_cdp(port)
        ws = WS(ver["webSocketDebuggerUrl"])
        ext_id = ws.call("Extensions.loadUnpacked", {"path": ext}).get("id")
        print(f"扩展已加载，ID = {ext_id}\n")

        # v1.3.0 起没有免 Key 引擎了：用本地模拟的大模型服务顶上
        mock = testenv.MockLLM("openai-string")
        print(f"模拟大模型服务：{mock.base}\n")

        # 找到 service worker
        sw_sess = None
        for _ in range(20):
            for t in ws.call("Target.getTargets").get("targetInfos", []):
                if t.get("type") == "service_worker" and ext_id in t.get("url", ""):
                    sw_sess = ws.call("Target.attachToTarget",
                                      {"targetId": t["targetId"], "flatten": True})["sessionId"]
                    break
            if sw_sess:
                break
            time.sleep(0.5)
        if not sw_sess:
            sys.exit("！未找到扩展 service worker")

        testenv.write_engine(ws, sw_sess, mock.engine())

        for site in sites:
            print(f"── {site}")
            tgt = ws.call("Target.createTarget", {"url": "about:blank"})["targetId"]
            sess = ws.call("Target.attachToTarget", {"targetId": tgt, "flatten": True})["sessionId"]
            ws.call("Page.enable", {}, sess)
            ws.call("Runtime.enable", {}, sess)
            ws.call("Page.navigate", {"url": site}, sess)
            time.sleep(4)

            def page_eval(expr, await_promise=False):
                r = ws.call("Runtime.evaluate",
                            {"expression": expr, "returnByValue": True,
                             "awaitPromise": await_promise}, sess)
                if r.get("exceptionDetails"):
                    return "EXCEPTION " + json.dumps(r["exceptionDetails"])[:200]
                return r.get("result", {}).get("value")

            # 等页面内容稳定后再开始翻译，否则会把「页面还没到」误判成识别失败
            wait_for_content(ws, sess)
            time.sleep(1)

            # 发翻译指令（与 popup 同一套消息协议）
            ws.call("Runtime.evaluate", {
                "expression": (
                    "new Promise(res=>{chrome.tabs.query({},ts=>{"
                    "var t=(ts||[]).filter(x=>String(x.url||'').indexOf(" +
                    json.dumps(site.split('://')[1].split('/')[0]) + ")>=0)[0] || (ts||[])[0];"
                    "if(!t)return res('no-tab');"
                    "chrome.tabs.sendMessage(t.id,{target:'imtl-content',action:'start'},"
                    "r=>res(JSON.stringify(r||{})));});})"
                ),
                "returnByValue": True, "awaitPromise": True,
            }, sw_sess)

            time.sleep(2)
            sel_probe = page_eval(PROBE)

            # 滚动整页 + 等待翻译
            page_eval(SCROLL, await_promise=True)
            for _ in range(args.wait):
                time.sleep(1)
            final = page_eval(PROBE)

            try:
                data = json.loads(final)
                data["selectionSnapshot"] = json.loads(sel_probe)
            except Exception:
                data = {"url": site, "error": str(final)[:300]}

            results.append(data)
            snap = data.get("selectionSnapshot", {})
            d = data
            print(f"   选段 {d.get('selected')}  译出 {d.get('translated')}  失败 {d.get('errors')}")
            print(f"   标题 {d.get('title')!r}  正文体量 {d.get('bodyChars')}  "
                  f"readyState={d.get('readyState')}  htmlLen={d.get('htmlLen')}")
            print(f"   早期快照(开始后2s): 选段 {snap.get('selected')}  正文体量 {snap.get('bodyChars')}")
            print(f"   泄漏[语义地标] {d.get('leakLandmark')}   "
                  f"链接密集区内 {d.get('inDense')}（其中纯链接型 {d.get('inDenseLinkish')}）")
            print(f"   正文段落 {d.get('contentParas')}   覆盖度 {d.get('coverage')}%")
            if d.get("leakSamples"):
                print(f"   地标泄漏样本: {d.get('leakSamples')}")
            if d.get("denseLinkishSamples"):
                print(f"   密集区纯链接样本: {d.get('denseLinkishSamples')}")
            print()

            try:
                ws.call("Target.closeTarget", {"targetId": tgt})
            except Exception:
                pass

        # 汇总
        print("═" * 78)
        print(f"{'站点':<30}{'选段':>7}{'译出':>7}{'地标泄漏':>10}{'密集纯链接':>12}{'覆盖%':>8}")
        print("─" * 78)
        for r in results:
            d = r
            host = (d.get("url") or "").replace("https://", "")[:29]
            print(f"{host:<30}{d.get('selected',0):>7}{d.get('translated',0):>7}"
                  f"{d.get('leakLandmark',0):>10}{d.get('inDenseLinkish',0):>12}"
                  f"{str(d.get('coverage')):>8}")
        print("═" * 78)

        if args.json:
            with open(args.json, "w") as f:
                json.dump(results, f, ensure_ascii=False, indent=2)
            print("结果已写入:", args.json)
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
    main()
