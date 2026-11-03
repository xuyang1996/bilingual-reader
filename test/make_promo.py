#!/usr/bin/env python3
"""
Bilingual Reader — 商店宣传图生成

用真实 Chrome 渲染一张 HTML 宣传页，导出三个尺寸的宣传图。
所有输出都会被压平成**不带 alpha 通道**的 RGB PNG（商店要求）。

用法:
    python3 test/make_promo.py --out-dir store
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

CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"

# ---- 宣传页模板：不同尺寸用不同的排版比例 -------------------------

PROMO_HTML = """<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8"><style>
  * { box-sizing: border-box; }
  html, body { margin:0; padding:0; width:__W__dpx; height:__H__dpx; overflow:hidden; }
  body {
    background: linear-gradient(135deg, #0b3d91 0%, #0b6bcb 45%, #45b0ff 100%);
    color:#fff; font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;
    display:flex; flex-direction:column; justify-content:center;
    padding:__PAD__px; position:relative;
  }
  .glow { position:absolute; border-radius:50%; filter:blur(60px); opacity:.35; }
  .g1 { width:__BLUR__px; height:__BLUR__px; background:#7fd8ff; right:-__BLUR4__px; top:-__BLUR4__px; }
  .g2 { width:__BLUR__px; height:__BLUR__px; background:#0a2f6b; left:-__BLUR6__px; bottom:-__BLUR6__px; }
  .badge {
    display:inline-block; align-self:flex-start;
    background:rgba(255,255,255,.16); border:1px solid rgba(255,255,255,.35);
    border-radius:999px; padding:__BP__px __BP2__px; font-size:__FS__px; font-weight:600;
    letter-spacing:.02em; margin-bottom:__GAP2__px;
  }
  h1 { margin:0 0 __GAP3__px 0; font-size:__H1__px; line-height:1.12; font-weight:800; letter-spacing:-.02em; }
  h1 .en { display:block; font-size:__H1E__px; font-weight:600; opacity:.85; margin-top:__GAP4__px; }
  p { margin:0; font-size:__SUB__px; line-height:1.5; opacity:.92; max-width:__MAXW__px; }
  .row { display:flex; gap:__GAP__px; margin-top:__GAP5__px; flex-wrap:wrap; }
  .chip {
    background:rgba(255,255,255,.14); border:1px solid rgba(255,255,255,.28);
    border-radius:8px; padding:__CP__px __CP2__px; font-size:__FS2__px; font-weight:500;
  }
  .demo { margin-top:__GAP6__px; background:rgba(255,255,255,.1); border-left:3px solid #ffd479;
          padding:__CP3__px __CP4__px; border-radius:0 8px 8px 0; font-size:__FS3__px; opacity:.95; }
</style></head><body>
  <div class="glow g1"></div><div class="glow g2"></div>
  <div class="badge">Chrome MV3 · 开源 · 无广告无遥测</div>
  <h1>双语对照翻译<span class="en">Bilingual Reader</span></h1>
  <p>只翻正文，原文在上译文在下。<br>支持各家大模型 API 与本地模型，Key 只存在你自己的机器上。</p>
  <div class="row">
    <div class="chip">段落级对照</div>
    <div class="chip">智能正文识别</div>
    <div class="chip">14 种翻译风格</div>
    <div class="chip">术语库</div>
    <div class="chip">PII 脱敏</div>
    <div class="chip">本地模型可用</div>
  </div>
  <div class="demo">需要自备大模型 API Key；扩展内置演示模式，可离线体验界面与流程。</div>
</body></html>"""


def build_html(w, h):
    big = w >= 900
    mid = w >= 600
    vals = {
        "W": w, "H": h,
        "PAD": 64 if big else (48 if mid else 34),
        "BLUR": int(w * 0.42), "BLUR4": int(w * 0.10), "BLUR6": int(w * 0.08),
        "BP": 8 if big else 6, "BP2": 18 if big else 14,
        "FS": 20 if big else (16 if mid else 12),
        "FS2": 19 if big else (15 if mid else 11),
        "FS3": 18 if big else (14 if mid else 10),
        "H1": 66 if big else (46 if mid else 30),
        "H1E": 30 if big else (21 if mid else 14),
        "SUB": 26 if big else (19 if mid else 13),
        "MAXW": int(w * 0.78),
        "GAP": 12 if big else 8,
        "GAP2": 24 if big else 16,
        "GAP3": 26 if big else 16,
        "GAP4": 10 if big else 6,
        "GAP5": 30 if big else 18,
        "GAP6": 26 if big else 14,
        "CP": 10 if big else 7, "CP2": 18 if big else 12,
        "CP3": 12 if big else 9, "CP4": 16 if big else 12,
    }
    out = PROMO_HTML
    for k, v in vals.items():
        out = out.replace("__%s__" % k, str(v))
    return out


def shoot(ws, sess, out_path, w, h):
    shot = ws.call("Page.captureScreenshot", {
        "format": "png",
        "clip": {"x": 0, "y": 0, "width": w, "height": h, "scale": 1},
        "captureBeyondViewport": True
    }, sess)
    with open(out_path, "wb") as f:
        f.write(base64.b64decode(shot["data"]))
    print("  →", os.path.basename(out_path))


def flatten_to_rgb(path):
    """把 PNG 压平成不带 alpha 通道的 RGB（商店硬性要求）"""
    from struct import unpack
    import zlib
    with open(path, "rb") as f:
        data = f.read()
    assert data[:8] == b"\x89PNG\r\n\x1a\n", "不是 PNG"

    pos = 8
    idat = b""
    w = h = bitdepth = colortype = None
    while pos < len(data):
        ln = unpack(">I", data[pos:pos + 4])[0]
        typ = data[pos + 4:pos + 8]
        body = data[pos + 8:pos + 8 + ln]
        if typ == b"IHDR":
            w, h, bitdepth, colortype = unpack(">IIBB", body[:10])
        elif typ == b"IDAT":
            idat += body
        pos += 12 + ln

    assert bitdepth == 8, "只处理 8bit 位深，实际 %s" % bitdepth
    channels = {0: 1, 2: 3, 3: 1, 4: 2, 6: 4}[colortype]
    raw = zlib.decompress(idat)
    stride = w * channels

    # 逐行反滤波
    out = bytearray()
    prev = bytearray(stride)
    p = 0
    for _ in range(h):
        ft = raw[p]
        p += 1
        line = bytearray(raw[p:p + stride])
        p += stride
        if ft == 1:
            for i in range(channels, stride):
                line[i] = (line[i] + line[i - channels]) & 0xFF
        elif ft == 2:
            for i in range(stride):
                line[i] = (line[i] + prev[i]) & 0xFF
        elif ft == 3:
            for i in range(stride):
                a = line[i - channels] if i >= channels else 0
                line[i] = (line[i] + ((a + prev[i]) >> 1)) & 0xFF
        elif ft == 4:
            for i in range(stride):
                a = line[i - channels] if i >= channels else 0
                c = prev[i - channels] if i >= channels else 0
                b = prev[i]
                pp = a + b - c
                pa, pb, pc = abs(pp - a), abs(pp - b), abs(pp - c)
                pr = a if (pa <= pb and pa <= pc) else (b if pb <= pc else c)
                line[i] = (line[i] + pr) & 0xFF
        out += line
        prev = line

    # 转成 RGB（丢弃 alpha），白底合成
    rgb = bytearray()
    for y in range(h):
        base = y * stride
        rgb.append(0)          # 每行前面要有一个 filter 类型字节（0 = None）
        for x in range(w):
            o = base + x * channels
            if channels == 3:
                rgb += out[o:o + 3]
            elif channels == 4:
                r, g, b, a = out[o], out[o + 1], out[o + 2], out[o + 3]
                rgb += bytes(((r * a + 255 * (255 - a)) // 255,
                             (g * a + 255 * (255 - a)) // 255,
                             (b * a + 255 * (255 - a)) // 255))
            elif channels == 1:
                v = out[o]
                rgb += bytes((v, v, v))
            elif channels == 2:
                v, a = out[o], out[o + 1]
                rgb += bytes(((v * a + 255 * (255 - a)) // 255,
                             (v * a + 255 * (255 - a)) // 255,
                             (v * a + 255 * (255 - a)) // 255))

    def chunk(typ, body):
        return (unpack(">I", len(body).to_bytes(4, "big"))[0].to_bytes(4, "big")
                + typ + body
                + (zlib.crc32(typ + body) & 0xFFFFFFFF).to_bytes(4, "big"))

    ihdr = w.to_bytes(4, "big") + h.to_bytes(4, "big") + bytes([8, 2, 0, 0, 0])
    png = (b"\x89PNG\r\n\x1a\n"
           + chunk(b"IHDR", ihdr)
           + chunk(b"IDAT", zlib.compress(bytes(rgb), 9))
           + chunk(b"IEND", b""))
    with open(path, "wb") as f:
        f.write(png)
    return w, h


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--chrome", default=CHROME)
    ap.add_argument("--out-dir", default="store")
    args = ap.parse_args()
    out_dir = os.path.abspath(args.out_dir)
    os.makedirs(out_dir, exist_ok=True)

    port = find_free_port()
    profile = tempfile.mkdtemp(prefix="br-promo-")
    proc = subprocess.Popen(
        [args.chrome, "--headless=new", "--disable-gpu", "--no-sandbox", "--hide-scrollbars",
         f"--remote-debugging-port={port}", f"--user-data-dir={profile}",
         "--window-size=1400,900", "about:blank"],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    ws = None
    try:
        ver = wait_for_cdp(port)
        ws = WS(ver["webSocketDebuggerUrl"])
        tgt = ws.call("Target.createTarget", {"url": "about:blank"})["targetId"]
        sess = ws.call("Target.attachToTarget", {"targetId": tgt, "flatten": True})["sessionId"]
        ws.call("Page.enable", {}, sess)
        ws.call("Runtime.enable", {}, sess)

        sizes = [
            ("promo-small-440x280.png", 440, 280),
            ("promo-large-920x680.png", 920, 680),
            ("promo-marquee-1400x560.png", 1400, 560),
        ]
        for name, w, h in sizes:
            html = build_html(w, h)
            tmp = os.path.join(profile, "promo.html")
            with open(tmp, "w", encoding="utf-8") as f:
                f.write(html)
            ws.call("Emulation.setDeviceMetricsOverride",
                    {"width": w, "height": h, "deviceScaleFactor": 1, "mobile": False}, sess)
            ws.call("Page.navigate", {"url": "file://" + tmp}, sess)
            time.sleep(1.2)
            path = os.path.join(out_dir, name)
            shoot(ws, sess, path, w, h)
            rw, rh = flatten_to_rgb(path)
            print("     尺寸 %dx%d，已压平为无 alpha 的 RGB" % (rw, rh))
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
