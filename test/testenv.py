#!/usr/bin/env python3
"""
Bilingual Reader — 测试基座

v1.3.0 起扩展只支持对接大模型 API，不再有免 Key 的免费引擎。
因此所有需要「真实翻译」的测试都用本地模拟的大模型服务顶上：

    启动 mock 服务 → 把引擎配置写进 chrome.storage → 打开页面翻译

这样测试既不依赖真实 API Key，也不受任何厂商限流影响。
"""
import json
import os
import sys
import time
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import mock_llm_server  # noqa: E402


class MockLLM:
    """本地模拟大模型服务"""

    def __init__(self, mode="openai-string"):
        self.server = mock_llm_server.serve(0)
        self.base = "http://127.0.0.1:%d" % self.server.server_address[1]
        self.set_mode(mode)

    def set_mode(self, mode):
        urllib.request.urlopen(f"{self.base}/__mode/{mode}", timeout=5).read()

    def requests(self):
        return json.loads(urllib.request.urlopen(f"{self.base}/__requests", timeout=5).read())

    def reset(self):
        urllib.request.urlopen(f"{self.base}/__reset", timeout=5).read()

    def stop(self):
        try:
            self.server.shutdown()
        except Exception:
            pass

    def engine(self, **over):
        """一份指向本 mock 的引擎配置"""
        e = {
            "id": "mock", "name": "Mock", "type": "ai", "format": "openai",
            "baseUrl": self.base + "/v1", "path": "", "model": "mock-model",
            "key": "sk-test", "auth": "auto", "batchSize": 1, "timeout": 30,
        }
        e.update(over)
        return e


def find_service_worker(ws, ext_id, timeout=15):
    """找到扩展的 service worker 并附着上去"""
    t0 = time.time()
    while time.time() - t0 < timeout:
        for t in ws.call("Target.getTargets").get("targetInfos", []):
            if t.get("type") == "service_worker" and ext_id in t.get("url", ""):
                return ws.call("Target.attachToTarget",
                               {"targetId": t["targetId"], "flatten": True})["sessionId"]
        time.sleep(0.5)
    return None


def write_engine(ws, sw, engine, extra=None):
    """
    把引擎配置写进 chrome.storage，并立刻回读校验。

    extra 用来顺带写其他配置项（例如 scenario / cache）。
    """
    payload = json.dumps(engine, ensure_ascii=False)
    extra_json = json.dumps(extra or {}, ensure_ascii=False)
    ws.call("Runtime.evaluate", {
        "expression": (
            "new Promise(res=>{chrome.storage.local.get('imtl.config',d=>{"
            "var cfg=d['imtl.config']||{};cfg.engines=cfg.engines||{};"
            f"cfg.engines['mock']={payload};"
            "cfg.engine='mock';cfg.cache={enabled:false,maxAgeDay:30};"
            f"Object.assign(cfg,{extra_json});"
            "chrome.storage.local.set({'imtl.config':cfg},()=>res('ok'));});})"),
        "returnByValue": True, "awaitPromise": True}, sw)
    back = ws.call("Runtime.evaluate", {
        "expression": ("new Promise(res=>{chrome.storage.local.get('imtl.config',"
                       "d=>{var c=d['imtl.config']||{};"
                       "res(JSON.stringify({engine:c.engine,"
                       "hasMock:!!(c.engines&&c.engines.mock)}));});})"),
        "returnByValue": True, "awaitPromise": True}, sw).get("result", {}).get("value")
    return back


def start_translation(ws, sw, url_fragment="demo.html", timeout=10):
    """让内容脚本开始翻译当前匹配的标签页"""
    return ws.call("Runtime.evaluate", {
        "expression": (
            "new Promise(res=>{chrome.tabs.query({},ts=>{"
            f"var t=(ts||[]).filter(x=>String(x.url||'').indexOf('{url_fragment}')>=0)[0];"
            "if(!t)return res('no-tab');"
            "chrome.tabs.sendMessage(t.id,{target:'imtl-content',action:'start'},"
            "r=>res('sent'));});})"),
        "returnByValue": True, "awaitPromise": True}, sw)
