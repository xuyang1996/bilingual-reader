#!/usr/bin/env python3
"""
Bilingual Reader — 端到端验证脚本

用 Chrome DevTools Protocol 的 Extensions.loadUnpacked 加载未打包扩展，
在真实浏览器里跑通完整链路：

    扩展加载 → content script 注入 → 正文识别 → 懒翻译调度
    → background 消息路由 → 翻译引擎真实请求 → DOM 渲染

为什么不用 --load-extension：Google Chrome 品牌版会忽略该命令行开关
（Chromium 品牌版会忽略，官方日志里有 "--load-extension is not allowed in
Google Chrome, ignoring."），而 CDP 的 Extensions.loadUnpacked 不受此限制。

用法：
    python3 test/e2e.py \
        --chrome "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
        --ext ./bilingual-reader \
        --url http://127.0.0.1:8766/bilingual-reader/demo/demo.html \
        --out /tmp/e2e.png

依赖：只需 Python 3 标准库。
"""
import argparse
import base64
import json
import os
import shutil
import socket
import struct
import subprocess
import sys
import tempfile
import time
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import testenv  # noqa: E402


# --------------------------------------------------------------------------
# 最小 WebSocket 客户端（只为跑 CDP，无需第三方库）
# --------------------------------------------------------------------------
class WS:
    def __init__(self, url):
        assert url.startswith("ws://"), url
        rest = url[5:]
        hostport, _, path = rest.partition("/")
        host, _, port = hostport.partition(":")
        self.sock = socket.create_connection((host, int(port or 80)))
        self.sock.settimeout(40)
        key = base64.b64encode(os.urandom(16)).decode()
        req = (
            f"GET /{path} HTTP/1.1\r\nHost: {hostport}\r\nUpgrade: websocket\r\n"
            f"Connection: Upgrade\r\nSec-WebSocket-Key: {key}\r\n"
            f"Sec-WebSocket-Version: 13\r\n\r\n"
        )
        self.sock.sendall(req.encode())
        buf = b""
        while b"\r\n\r\n" not in buf:
            chunk = self.sock.recv(4096)
            if not chunk:
                raise IOError("handshake closed")
            buf += chunk
        head, self.buf = buf.split(b"\r\n\r\n", 1)
        if b" 101 " not in head.split(b"\r\n")[0]:
            raise IOError("handshake failed: " + head[:200].decode("latin1"))
        self._id = 0

    def _exact(self, n):
        while len(self.buf) < n:
            d = self.sock.recv(65536)
            if not d:
                raise IOError("closed")
            self.buf += d
        out, self.buf = self.buf[:n], self.buf[n:]
        return out

    def send(self, obj):
        payload = json.dumps(obj).encode()
        header = bytearray([0x81])
        n = len(payload)
        mask = os.urandom(4)
        if n < 126:
            header.append(0x80 | n)
        elif n < 65536:
            header.append(0x80 | 126)
            header += struct.pack(">H", n)
        else:
            header.append(0x80 | 127)
            header += struct.pack(">Q", n)
        header += mask
        self.sock.sendall(bytes(header) + bytes(b ^ mask[i % 4] for i, b in enumerate(payload)))

    def recv(self):
        while True:
            b1, b2 = self._exact(2)
            opcode = b1 & 0x0F
            length = b2 & 0x7F
            if length == 126:
                length = struct.unpack(">H", self._exact(2))[0]
            elif length == 127:
                length = struct.unpack(">Q", self._exact(8))[0]
            data = self._exact(length)
            if opcode == 1:
                return json.loads(data.decode())
            if opcode == 8:
                raise IOError("closed by peer")

    def call(self, method, params=None, session_id=None, timeout=40):
        self._id += 1
        mid = self._id
        msg = {"id": mid, "method": method}
        if params:
            msg["params"] = params
        if session_id:
            msg["sessionId"] = session_id
        self.send(msg)
        t0 = time.time()
        while True:
            r = self.recv()
            if r.get("id") == mid:
                if "error" in r:
                    raise RuntimeError(f"{method}: {r['error']}")
                return r.get("result", {})
            if time.time() - t0 > timeout:
                raise TimeoutError(method)


def find_free_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


def wait_for_cdp(port, timeout=25):
    t0 = time.time()
    while time.time() - t0 < timeout:
        try:
            return json.load(urllib.request.urlopen(f"http://127.0.0.1:{port}/json/version", timeout=3))
        except Exception:
            time.sleep(0.4)
    raise TimeoutError("CDP 未就绪")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--chrome", default="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome")
    ap.add_argument("--ext", required=True, help="扩展目录（含 manifest.json）")
    ap.add_argument("--url", required=True, help="要翻译的页面 URL")
    ap.add_argument("--out", default="/tmp/bilingual-reader-e2e.png", help="截图输出路径")
    ap.add_argument("--wait", type=int, default=10, help="翻译后等待秒数")
    ap.add_argument("--port", type=int, default=0)
    args = ap.parse_args()

    ext = os.path.abspath(args.ext)
    if not os.path.exists(os.path.join(ext, "manifest.json")):
        sys.exit(f"不是扩展目录（缺 manifest.json）：{ext}")
    if not os.path.exists(args.chrome):
        sys.exit(f"找不到 Chrome：{args.chrome}")

    port = args.port or find_free_port()
    profile = tempfile.mkdtemp(prefix="br-e2e-")
    proc = subprocess.Popen(
        [
            args.chrome, "--headless=new", "--disable-gpu", "--no-sandbox", "--hide-scrollbars",
            f"--remote-debugging-port={port}", f"--user-data-dir={profile}",
            "--window-size=1280,2000", "about:blank",
        ],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )

    ws = None
    mock = None
    try:
        ver = wait_for_cdp(port)
        ws = WS(ver["webSocketDebuggerUrl"])
        print("CDP:", ver.get("Browser"))

        res = ws.call("Extensions.loadUnpacked", {"path": ext})
        ext_id = res.get("id")
        print("扩展已加载，ID =", ext_id)

        # v1.3.0 起没有免 Key 引擎了：用本地模拟的大模型服务顶上
        mock = testenv.MockLLM("openai-string")
        print("模拟大模型服务：", mock.base)

        sw = testenv.find_service_worker(ws, ext_id)
        if not sw:
            print("！未找到扩展 service worker")
        else:
            print("service worker 已就绪")
            back = testenv.write_engine(ws, sw, mock.engine())
            print("引擎配置：", back)

        tgt = ws.call("Target.createTarget", {"url": "about:blank"})["targetId"]
        sess = ws.call("Target.attachToTarget", {"targetId": tgt, "flatten": True})["sessionId"]
        ws.call("Page.enable", {}, sess)
        ws.call("Runtime.enable", {}, sess)
        ws.call("Page.navigate", {"url": args.url}, sess)
        time.sleep(3)

        def page_eval(expr):
            r = ws.call("Runtime.evaluate",
                        {"expression": expr, "returnByValue": True, "awaitPromise": True}, sess)
            if r.get("exceptionDetails"):
                return "EXCEPTION " + json.dumps(r["exceptionDetails"])[:300]
            return r.get("result", {}).get("value")

        # 触发翻译（与 popup 同一套消息协议）
        if sw:
            testenv.start_translation(ws, sw, "demo.html")

        print(f"等待 {args.wait}s 让懒翻译逐步补翻…")
        for i in range(args.wait):
            time.sleep(1)
            info = page_eval(
                "JSON.stringify({n:document.querySelectorAll('.imtl-translation').length,"
                "err:document.querySelectorAll('.imtl-error').length})"
            )
            print(f"  +{i+1}s {info}")

        final = page_eval(
            "JSON.stringify({translations:document.querySelectorAll('.imtl-translation').length,"
            "errors:document.querySelectorAll('.imtl-error').length,"
            "blocks:document.querySelectorAll('.imtl-block').length,"
            "sample:(document.querySelector('.imtl-translation')||{}).textContent||''})"
        )
        print("结果:", final)

        shot = ws.call("Page.captureScreenshot",
                       {"format": "png", "captureBeyondViewport": True}, sess)
        with open(args.out, "wb") as f:
            f.write(base64.b64decode(shot["data"]))
        print("截图:", args.out)

        try:
            ws.call("Target.closeTarget", {"targetId": tgt})
        except Exception:
            pass
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
