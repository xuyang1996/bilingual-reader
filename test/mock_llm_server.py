#!/usr/bin/env python3
"""
Bilingual Reader — 本地模拟大模型服务

用来在没有真实 API Key 的情况下，端到端验证「通用大模型引擎」这条链路：
真实 Chrome + 真实扩展 + 真实 HTTP 请求 → 本地模拟服务。

它同时扮演「各种不太一样的接口」，用来验证兼容性：

  POST /v1/chat/completions   OpenAI 兼容（字符串 / parts 数组 / Responses 形态）
  POST /chat/completions      同上（部分服务没有 /v1 段）
  POST /v1/messages           Anthropic Messages
  POST /v1beta/models/{m}:generateContent   Gemini
  POST /sse/chat/completions  事件流（模拟不听话的网关）
  其它路径                    404 —— 用来验证地址候选回退

控制接口：
  GET /__mode/<name>   切换返回形态
  GET /__requests      取回收到的请求（用于断言）

鉴权行为：
  默认要求 Authorization 头；用 /__mode/no-bearer 可以改成只认 x-api-key，
  用来验证鉴权方式自动回退。
"""
import json
import re
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

STATE = {
    "mode": "openai-string",
    "requests": [],
    "lock": threading.Lock(),
}

# 已知短语 → 中文译文，其余按「译:原文」处理
KNOWN = {
    "hello world": "你好世界",
    "bilingual reader": "双语阅读器",
    "demo": "演示",
    "readme.md": "README.md",
}

# 目标语言标记：系统提示词里会出现目标语言名，据此给译文加前缀
# （这样「切换目标语言」能被真实断言，而不是换个说法而已）
LANG_MARKERS = [
    ("日本語", "JA:"),
    ("한국어", "KO:"),
    ("繁體中文", "繁:"),
    ("简体中文", "译:"),
    ("中文", "译:"),
    ("Français", "FR:"),
    ("Deutsch", "DE:"),
    ("Español", "ES:"),
]


def detect_target(system_text):
    """从系统提示词里认出目标语言，返回译文前缀"""
    s = str(system_text or "")
    for name, prefix in LANG_MARKERS:
        if name in s:
            return prefix
    return "译:"


def translate(text, prefix="译:"):
    low = text.strip().lower()
    if low in KNOWN:
        return KNOWN[low]
    for k, v in KNOWN.items():
        if low.startswith(k):
            return v + text.strip()[len(k):].strip()
    # 演示页里有 "Bilingual Reader / demo / README.md" 这类用 / 串起来的标题
    if " / " in text:
        return " / ".join(translate(part, prefix) for part in text.split(" / "))
    return prefix + text.strip()


def split_numbered(content):
    """把 '1. xxx\\n2. yyy' 拆成 [(1,'xxx'), (2,'yyy')]；不是编号列表则返回 None"""
    lines = [l for l in str(content).split("\n") if l.strip()]
    if len(lines) < 2:
        return None
    out = []
    for i, line in enumerate(lines, 1):
        m = re.match(r"^\s*(\d+)\.\s*(.*)$", line)
        if not m:
            return None
        if int(m.group(1)) != i:
            return None
        out.append((i, m.group(2)))
    return out


def openai_reply(content, mode, prefix="译:", study=False):
    lookup = json.loads(content) if study else {}
    sentence = lookup.get("sentence")
    word = lookup.get("word")
    vocabulary = {"text": "waiting", "headword": "wait", "ipa": "ˈweɪtɪŋ",
                  "meaning": "正在等候。", "root": "wait（等候）加上 -ing。"}
    numbered = split_numbered(content)
    if word and mode != "study-invalid":
        body = json.dumps({"word": dict(vocabulary, text=word)}, ensure_ascii=False)
    elif sentence and mode != "study-invalid":
        body = "```json\n" + json.dumps({
            "main": {"text": sentence, "explanation": "说清谁做了什么。"},
            "detail": "说明事情发生的时间。",
            "phrases": [{"text": "ran into", "explanation": "偶然碰见。"}],
            "words": [vocabulary] if "waiting" in sentence else [],
        }, ensure_ascii=False) + "\n```"
    elif numbered is not None:
        body = "\n".join("%d. %s" % (i, translate(t, prefix)) for i, t in numbered)
    else:
        body = translate(content, prefix)

    if mode == "openai-parts":
        return {"choices": [{"message": {"role": "assistant",
                "content": [{"type": "text", "text": body}]}}]}
    if mode == "responses":
        return {"output": [{"content": [{"type": "output_text", "text": body}]}]}
    if mode == "reasoning":
        # 推理模型：思维链在 reasoning_content，正式译文在 content
        return {"choices": [{"message": {
            "role": "assistant",
            "reasoning_content": "（这段是思维链，不能混进译文）",
            "content": body}}]}
    if mode == "openai-empty-then-text":
        return {"choices": [{"message": {"role": "assistant", "content": body}}],
                "translations": [{"text": body}]}
    return {"choices": [{"message": {"role": "assistant", "content": body}}]}


def anthropic_reply(content, prefix="译:"):
    numbered = split_numbered(content)
    if numbered is not None:
        body = "\n".join("%d. %s" % (i, translate(t, prefix)) for i, t in numbered)
    else:
        body = translate(content, prefix)
    return {"id": "msg_mock", "type": "message", "role": "assistant",
            "content": [{"type": "text", "text": body}]}


def gemini_reply(content, prefix="译:"):
    numbered = split_numbered(content)
    if numbered is not None:
        body = "\n".join("%d. %s" % (i, translate(t, prefix)) for i, t in numbered)
    else:
        body = translate(content, prefix)
    return {"candidates": [{"content": {"role": "model",
            "parts": [{"text": body}]}, "finishReason": "STOP"}]}


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def handle(self):
        try:
            super().handle()
        except (BrokenPipeError, ConnectionResetError):
            pass  # A cancelled fetch can also close a keep-alive connection.

    def log_message(self, *a):        # 静音
        pass

    def _json(self, obj, code=200):
        raw = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        try:
            self.wfile.write(raw)
        except (BrokenPipeError, ConnectionResetError):
            pass  # Pause/restore intentionally aborts HTTP requests.

    def _text(self, raw, code=200, ctype="application/json; charset=utf-8"):
        if isinstance(raw, str):
            raw = raw.encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def do_GET(self):
        if self.path.startswith("/__mode/"):
            mode = self.path.split("/__mode/", 1)[1].strip("/")
            with STATE["lock"]:
                STATE["mode"] = mode or "openai-string"
            return self._json({"ok": True, "mode": STATE["mode"]})
        if self.path.startswith("/__requests"):
            with STATE["lock"]:
                return self._json({"requests": list(STATE["requests"])})
        if self.path.startswith("/__reset"):
            with STATE["lock"]:
                STATE["requests"] = []
            return self._json({"ok": True})
        return self._json({"error": {"message": "not found"}}, 404)

    def do_POST(self):
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length) if length else b""
        try:
            payload = json.loads(raw.decode("utf-8"))
        except Exception:
            payload = {}

        with STATE["lock"]:
            STATE["requests"].append({
                "path": self.path,
                "headers": {k.lower(): v for k, v in self.headers.items()},
                "body": payload,
            })
            mode = STATE["mode"]

        if mode == "retired-model":
            return self._json({"error": {"message":
                'The model "MiniMax-Text-01" is no longer available. (2069)'}}, 404)

        if mode == "slow-openai":
            time.sleep(.2)
        if mode == "study-slow":
            time.sleep(1)

        # 鉴权：默认要求 Bearer；no-bearer 模式只认 x-api-key
        if mode != "no-auth":
            auth = self.headers.get("Authorization", "")
            xkey = self.headers.get("x-api-key", "")
            apikey = self.headers.get("api-key", "")
            # Gemini 这类接口用 ?key= 传密钥，没有请求头
            query_key = ""
            if "?" in self.path:
                for kv in self.path.split("?", 1)[1].split("&"):
                    if kv.startswith("key="):
                        query_key = kv[4:]
            if mode == "no-bearer":
                if not xkey and not apikey:
                    return self._json({"error": {"message": "missing x-api-key"}}, 401)
            elif not auth and not xkey and not apikey and not query_key:
                return self._json({"error": {"message": "missing Authorization"}}, 401)

        # 取出用户消息
        content = ""
        system_text = ""
        if "messages" in payload:
            for m in payload["messages"]:
                c = m.get("content")
                c = c if isinstance(c, str) else json.dumps(c, ensure_ascii=False)
                if m.get("role") == "user" and not content:
                    content = c
                elif m.get("role") in ("system", "developer") and not system_text:
                    system_text = c
        elif "contents" in payload:
            parts = payload["contents"][0].get("parts") or []
            content = "\n".join(p.get("text", "") for p in parts)
            if payload.get("systemInstruction"):
                si = payload["systemInstruction"]
                if isinstance(si, dict):
                    sp = si.get("parts") or []
                    system_text = "\n".join(p.get("text", "") for p in sp)

        prefix = detect_target(system_text)

        path = self.path.split("?")[0]

        if path.startswith("/v1beta/models/") and path.endswith(":generateContent"):
            return self._json(gemini_reply(content, prefix))
        if path == "/v1/messages":
            return self._json(anthropic_reply(content, prefix))
        if path in ("/v1/chat/completions", "/chat/completions"):
            # only-v1 模式：只提供带 /v1 的地址，用来验证「地址候选回退」
            if mode == "only-v1" and path == "/chat/completions":
                return self._json({"error": {"message": "not found"}}, 404)
            if mode == "sse":
                body = openai_reply(content, "openai-string", prefix)
                text = body["choices"][0]["message"]["content"]
                chunks = ["data: " + json.dumps(
                    {"choices": [{"delta": {"content": text[:len(text) // 2]}}]},
                    ensure_ascii=False) + "\n\n",
                    "data: " + json.dumps(
                        {"choices": [{"delta": {"content": text[len(text) // 2:]}}]},
                        ensure_ascii=False) + "\n\n",
                    "data: [DONE]\n\n"]
                return self._text("".join(chunks), 200, "text/event-stream")
            return self._json(openai_reply(content, mode, prefix, study="英语初学者" in system_text))
        if path == "/responses" or path == "/v1/responses":
            body = openai_reply(content, "responses", prefix)
            return self._json(body)

        return self._json({"error": {"message": "unknown path: " + path}}, 404)


def serve(port=0):
    srv = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    t = threading.Thread(target=srv.serve_forever, daemon=True)
    t.start()
    return srv


if __name__ == "__main__":
    p = int(sys.argv[1]) if len(sys.argv) > 1 else 8767
    srv = serve(p)
    print("mock LLM 服务启动于 http://127.0.0.1:%d" % srv.server_address[1])
    try:
        threading.Event().wait()
    except KeyboardInterrupt:
        srv.shutdown()
