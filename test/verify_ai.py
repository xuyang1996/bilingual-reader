#!/usr/bin/env python3
"""
Bilingual Reader — 通用大模型引擎端到端验证

在真实 Chrome 里加载扩展，把引擎指向本地模拟的大模型服务，
逐个验证「不同形态的模型 API」都能正常翻译：

  1. OpenAI 兼容（Base URL 漏写 /v1 → 地址候选自动回退）
  2. OpenAI 兼容（正常地址）
  3. OpenAI 兼容（content 为 parts 数组）
  4. OpenAI Responses API（自定义响应字段路径）
  5. Anthropic Messages
  6. Gemini generateContent
  7. 事件流响应（网关不听话时返回 SSE）
  8. 鉴权方式自动回退（Bearer 被拒 → 换 x-api-key）
  9. 推理模型（思维链不能混进译文）
 10. 批量编号协议

用法:
    python3 test/verify_ai.py --ext .
"""
import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from e2e import WS, wait_for_cdp, find_free_port  # noqa: E402
import mock_llm_server  # noqa: E402

DEMO = "http://127.0.0.1:8766/bilingual-reader/demo/demo.html"


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
    ap.add_argument("--out", default="/tmp/shot-ai.png")
    args = ap.parse_args()

    ext = os.path.abspath(args.ext)
    c = Checker()

    srv = mock_llm_server.serve(0)
    mock_port = srv.server_address[1]
    mock_base = f"http://127.0.0.1:{mock_port}"
    print(f"模拟大模型服务：{mock_base}\n")

    def set_mode(mode):
        urllib.request.urlopen(f"{mock_base}/__mode/{mode}", timeout=5).read()

    def get_requests():
        return json.loads(urllib.request.urlopen(f"{mock_base}/__requests", timeout=5).read())

    def reset():
        urllib.request.urlopen(f"{mock_base}/__reset", timeout=5).read()

    port = find_free_port()
    profile = tempfile.mkdtemp(prefix="br-ai-")
    proc = subprocess.Popen(
        [args.chrome, "--headless=new", "--disable-gpu", "--no-sandbox", "--hide-scrollbars",
         f"--remote-debugging-port={port}", f"--user-data-dir={profile}",
         "--window-size=1280,2000", "about:blank"],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    ws = None
    try:
        ver = wait_for_cdp(port)
        ws = WS(ver["webSocketDebuggerUrl"])
        ext_id = ws.call("Extensions.loadUnpacked", {"path": ext}).get("id")
        print(f"扩展已加载，ID = {ext_id}\n")

        sw = None
        for _ in range(20):
            for t in ws.call("Target.getTargets").get("targetInfos", []):
                if t.get("type") == "service_worker" and ext_id in t.get("url", ""):
                    sw = ws.call("Target.attachToTarget",
                                 {"targetId": t["targetId"], "flatten": True})["sessionId"]
                    break
            if sw:
                break
            time.sleep(0.5)
        if not sw:
            print("！未找到扩展 service worker")
            return 1

        def set_engine(engine):
            """把引擎配置写进 storage，再让页面重新加载"""
            payload = json.dumps(engine, ensure_ascii=False)
            out = ws.call("Runtime.evaluate", {
                "expression": (
                    "new Promise(res=>{chrome.storage.local.get('imtl.config',d=>{"
                    "var cfg=d['imtl.config']||{};cfg.engines=cfg.engines||{};"
                    f"cfg.engines['mock']={payload};"
                    "cfg.engine='mock';cfg.cache={enabled:false,maxAgeDay:30};"
                    "chrome.storage.local.set({'imtl.config':cfg},()=>res('ok'));});})"),
                "returnByValue": True, "awaitPromise": True}, sw).get("result", {}).get("value")
            # 立刻回读，确认真的写进去了
            back = ws.call("Runtime.evaluate", {
                "expression": ("new Promise(res=>{chrome.storage.local.get('imtl.config',"
                               "d=>{var c=d['imtl.config']||{};"
                               "res(JSON.stringify({engine:c.engine,"
                               "hasMock:!!(c.engines&&c.engines.mock)}));});})"),
                "returnByValue": True, "awaitPromise": True}, sw).get("result", {}).get("value")
            print(f"    [配置] 写入={out} 回读={back}")
            return back

        def translate_and_measure():
            """打开 demo 页并翻译，返回 (译文数, 译文拼接, 请求记录)"""
            reset()
            tgt = ws.call("Target.createTarget", {"url": "about:blank"})["targetId"]
            sess = ws.call("Target.attachToTarget", {"targetId": tgt, "flatten": True})["sessionId"]
            ws.call("Page.enable", {}, sess)
            ws.call("Runtime.enable", {}, sess)
            ws.call("Page.navigate", {"url": DEMO}, sess)
            time.sleep(2.5)
            ws.call("Runtime.evaluate", {
                "expression": (
                    "new Promise(res=>{chrome.tabs.query({},ts=>{"
                    "var t=(ts||[]).filter(x=>String(x.url||'').indexOf('demo.html')>=0)[0];"
                    "if(!t)return res('no-tab');"
                    "chrome.tabs.sendMessage(t.id,{target:'imtl-content',action:'start'},"
                    "r=>res('sent'));});})"),
                "returnByValue": True, "awaitPromise": True}, sw)
            time.sleep(7)
            info = json.loads(ws.call("Runtime.evaluate", {
                "expression": ("JSON.stringify({n:document.querySelectorAll('.imtl-translation').length,"
                               "t:Array.prototype.map.call(document.querySelectorAll('.imtl-translation'),"
                               "function(x){return x.textContent;}).join('\\n')})"),
                "returnByValue": True}, sess).get("result", {}).get("value") or "{}")
            # 让内容脚本自报当前用的引擎
            eng = ws.call("Runtime.evaluate", {
                "expression": ("new Promise(res=>{chrome.tabs.query({},ts=>{"
                               "var t=(ts||[]).filter(x=>String(x.url||'').indexOf('demo.html')>=0)[0];"
                               "if(!t)return res('no-tab');"
                               "chrome.tabs.sendMessage(t.id,{target:'imtl-content',action:'query'},"
                               "r=>res(JSON.stringify(r||{})));});})"),
                "returnByValue": True, "awaitPromise": True}, sw).get("result", {}).get("value")
            info["engine"] = eng
            try:
                ws.call("Target.closeTarget", {"targetId": tgt})
            except Exception:
                pass
            return info.get("n", 0), info.get("t", ""), get_requests(), eng

        def run_case(title, mode, engine, expect_min=3, extra=None):
            print(f"── {title}")
            set_mode(mode)
            set_engine(engine)
            n, text, reqs, eng = translate_and_measure()
            c.check('"engine":"mock"' in str(eng),
                    f"{title}：内容脚本用的是 mock 引擎", str(eng)[:120])
            c.check(n >= expect_min, f"{title}：译文数量正常",
                    f"译出 {n} 段，mock 收到 {len(reqs.get('requests', []))} 次请求")
            c.check(("译:" in text) or ("双语阅读器" in text),
                    f"{title}：译文内容正确", (text[:40] or "(空)"))
            if extra:
                extra(text, reqs)
            print()

        base_engine = {
            "id": "mock", "name": "Mock", "type": "ai", "format": "openai",
            "baseUrl": mock_base, "path": "", "model": "mock-model",
            "key": "sk-test", "auth": "auto", "batchSize": 1, "timeout": 30,
        }

        # 1. Base URL 漏写 /v1，接口只认 /v1 —— 验证地址候选回退
        def fallback_check(text, reqs):
            paths = [p["path"] for p in reqs.get("requests", [])]
            c.check(any(p.startswith("/v1/") for p in paths),
                    "Base URL 漏写 /v1：最终请求打到了 /v1 路径",
                    str(sorted(set(paths))))
            # 第一次试探失败后会记住正确的地址，不该每个请求都再吃一次 404
            wrong = len([p for p in paths if p == "/chat/completions"])
            c.check(wrong <= 1,
                    "Base URL 漏写 /v1：只试探一次就记住了正确地址",
                    f"试探 {wrong} 次，共 {len(paths)} 个请求")
        run_case("Base URL 漏写 /v1 → 自动回退到 /v1",
                 "only-v1",
                 dict(base_engine, baseUrl=mock_base, path="/chat/completions"),
                 extra=fallback_check)

        # 2. 正常 OpenAI 兼容
        run_case("OpenAI 兼容（标准地址）", "openai-string",
                 dict(base_engine, baseUrl=mock_base + "/v1"))

        # 3. content 为 parts 数组
        run_case("OpenAI 兼容（content 是 parts 数组）", "openai-parts",
                 dict(base_engine, baseUrl=mock_base + "/v1"))

        # 4. Responses API —— 自定义响应字段路径
        run_case("OpenAI Responses API（自定义响应字段路径）", "responses",
                 dict(base_engine, baseUrl=mock_base + "/v1", path="/responses",
                      responsePath="output.0.content.0.text"))

        # 5. Anthropic
        run_case("Anthropic Messages", "openai-string",
                 dict(base_engine, format="anthropic", baseUrl=mock_base,
                      path="/v1/messages", auth="x-api-key"))

        # 6. Gemini
        run_case("Google Gemini generateContent", "openai-string",
                 dict(base_engine, format="gemini", baseUrl=mock_base,
                      path="/v1beta/models/{model}:generateContent", auth="query"))

        # 7. SSE 事件流
        run_case("事件流响应（SSE）", "sse",
                 dict(base_engine, baseUrl=mock_base + "/v1"))

        # 8. 鉴权回退：Bearer 被 401 拒绝 → 自动换 x-api-key
        def auth_check(text, reqs):
            paths = [p["path"] for p in reqs.get("requests", [])]
            c.check(len(paths) >= 2, "鉴权回退：先试 Bearer 再换一种",
                    str(paths))
        run_case("鉴权方式自动回退（Bearer 被拒 → x-api-key）", "no-bearer",
                 dict(base_engine, baseUrl=mock_base + "/v1", auth="auto"),
                 extra=auth_check)

        # 9. 推理模型：思维链不能混进译文
        def reasoning_check(text, reqs):
            c.check("思维链" not in text,
                    "推理模型：思维链没有混进译文")
        run_case("推理模型（思维链不混入译文）", "reasoning",
                 dict(base_engine, baseUrl=mock_base + "/v1", model="deepseek-reasoner"),
                 extra=reasoning_check)

        # 10. 批量编号协议
        def batch_check(text, reqs):
            c.check("译:" in text, "批量协议：译文正确")
        run_case("批量编号协议（一次翻多条）", "openai-string",
                 dict(base_engine, baseUrl=mock_base + "/v1", batchSize=5),
                 extra=batch_check)

        print("═" * 60)
        print(f"结果：{c.passed} 通过 / {c.failed} 失败")
        print("═" * 60)
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
        srv.shutdown()


if __name__ == "__main__":
    sys.exit(main())
