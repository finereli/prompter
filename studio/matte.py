#!/usr/bin/env python3
"""Put a talking-head take on a studio backdrop.

Separates the speaker with Robust Video Matting (recurrent, so edges stay
stable from frame to frame), brightens the speaker without touching the
background, composites onto a generated seamless backdrop, and crops to 16:9.

Usage: .venv/bin/python studio/matte.py in.mp4 out.mp4 [--start 15 --dur 10]
"""
import argparse, os, subprocess, sys, time

import numpy as np
import onnxruntime as ort

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MODEL = os.path.join(ROOT, "models", "rvm", "rvm_mobilenetv3_fp32.onnx")


def backdrop(w, h, cx, cy):
    """Seamless studio paper: charcoal with a soft pool of light behind the head."""
    y, x = np.mgrid[0:h, 0:w].astype(np.float32)
    d = np.sqrt(((x - cx) / (w * 0.55)) ** 2 + ((y - cy) / (h * 0.75)) ** 2)
    light = np.clip(1 - d, 0, 1) ** 1.6
    base = np.array([0.075, 0.082, 0.095], np.float32)   # cool charcoal
    glow = np.array([0.27, 0.27, 0.28], np.float32)      # neutral light
    img = base + light[..., None] * glow
    img += np.random.default_rng(0).normal(0, 0.004, img.shape).astype(np.float32)  # no banding
    return np.clip(img, 0, 1)


def grade(fg, exposure, warmth):
    """Lift the speaker: brighter midtones, a touch warmer, highlights protected."""
    out = 1 - (1 - fg) ** exposure          # >1 lifts shadows and mids, keeps whites from clipping
    out = out * np.array([1 + warmth, 1, 1 - warmth], np.float32)
    return np.clip(out, 0, 1)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("src")
    ap.add_argument("dst")
    ap.add_argument("--start", type=float, default=0)
    ap.add_argument("--dur", type=float, default=None)
    ap.add_argument("--exposure", type=float, default=1.6)
    ap.add_argument("--warmth", type=float, default=0.03)
    # 16:9 crop in source pixels: width, and the point to put on the upper third
    ap.add_argument("--crop-w", type=int, default=1600)
    ap.add_argument("--eyes", default="980,756", help="x,y of the eyes in the source frame")
    ap.add_argument("--downsample", type=float, default=0.25)
    ap.add_argument("--alpha-out", help="also write the matte as a greyscale video")
    args = ap.parse_args()

    probe = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries",
                            "stream=width,height", "-of", "csv=p=0", args.src], capture_output=True, text=True)
    W, H = map(int, probe.stdout.strip().split(","))
    ex, ey = map(int, args.eyes.split(","))
    cw, ch = args.crop_w, args.crop_w * 9 // 16
    cx0 = int(np.clip(ex - cw / 2, 0, W - cw))
    cy0 = int(np.clip(ey - ch / 3, 0, H - ch))

    trim = ["-ss", str(args.start)] + (["-t", str(args.dur)] if args.dur else [])
    dec = subprocess.Popen(["ffmpeg", "-v", "error", *trim, "-i", args.src, "-f", "rawvideo", "-pix_fmt", "rgb24",
                            "-r", "30", "-"], stdout=subprocess.PIPE)
    enc = subprocess.Popen(["ffmpeg", "-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{cw}x{ch}",
                            "-r", "30", "-i", "-", *trim, "-i", args.src, "-map", "0:v", "-map", "1:a?",
                            "-vf", "scale=1920:1080:flags=lanczos", "-c:v", "libx264", "-preset", "medium", "-crf", "18",
                            "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k", "-shortest", args.dst],
                           stdin=subprocess.PIPE)
    aenc = None
    if args.alpha_out:
        aenc = subprocess.Popen(["ffmpeg", "-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "gray", "-s", f"{cw}x{ch}",
                                 "-r", "30", "-i", "-", "-c:v", "libx264", "-crf", "18", "-pix_fmt", "yuv420p", args.alpha_out],
                                stdin=subprocess.PIPE)

    opts = ort.SessionOptions()
    opts.intra_op_num_threads = os.cpu_count()
    sess = ort.InferenceSession(MODEL, opts)
    rec = [np.zeros((1, 1, 1, 1), np.float32)] * 4
    ds = np.array([args.downsample], np.float32)
    bg = backdrop(cw, ch, ex - cx0, ey - cy0 + ch * 0.1)

    n, t_model, t0 = 0, 0.0, time.monotonic()
    frame_bytes = W * H * 3
    while True:
        raw = dec.stdout.read(frame_bytes)
        if len(raw) < frame_bytes:
            break
        frame = np.frombuffer(raw, np.uint8).reshape(H, W, 3)
        src = frame.astype(np.float32).transpose(2, 0, 1)[None] / 255
        tm = time.monotonic()
        fgr, pha, *rec = sess.run(None, {"src": src, "r1i": rec[0], "r2i": rec[1], "r3i": rec[2], "r4i": rec[3],
                                         "downsample_ratio": ds})
        t_model += time.monotonic() - tm
        sl = (slice(cy0, cy0 + ch), slice(cx0, cx0 + cw))
        fg = fgr[0].transpose(1, 2, 0)[sl]
        a = pha[0, 0][sl][..., None]
        out = grade(fg, args.exposure, args.warmth) * a + bg * (1 - a)
        enc.stdin.write((out * 255 + 0.5).astype(np.uint8).tobytes())
        if aenc:
            aenc.stdin.write((a[..., 0] * 255 + 0.5).astype(np.uint8).tobytes())
        n += 1
        if n % 30 == 0:
            el = time.monotonic() - t0
            print(f"{n} frames  {n / el:.1f} fps  (model {t_model / n * 1000:.0f} ms/frame)", file=sys.stderr)
    enc.stdin.close(); enc.wait()
    if aenc:
        aenc.stdin.close(); aenc.wait()
    el = time.monotonic() - t0
    print(f"done: {n} frames in {el:.0f}s ({n / max(el, 1e-6):.1f} fps)", file=sys.stderr)


if __name__ == "__main__":
    main()
