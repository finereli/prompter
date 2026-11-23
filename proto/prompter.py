#!/usr/bin/env python3
"""Voice-following teleprompter prototype.

Streams the mic through a local streaming ASR model (sherpa-onnx) and keeps a
position in the script by fuzzy-aligning the last few recognized words against
the text near where we think the reader is. Serves a page at
http://localhost:8765 that scrolls to that position.

Usage: .venv/bin/python prompter.py script.md [--mic omarchy_asahi_mic] [--threads 2]
"""
import argparse, glob, json, os, re, statistics, subprocess, sys, threading, time
from difflib import SequenceMatcher
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import numpy as np
import sherpa_onnx

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
RATE = 16000
CHUNK = 800  # 50 ms


def norm(w):
    return re.sub(r"[^a-z0-9']", "", w.lower().replace("’", "'"))


# ---------- script ----------

def load_script(path):
    """Display tokens (with paragraph markers) and the normalized words the aligner uses."""
    text = open(path).read()
    tokens, words = [], []
    for para in re.split(r"\n\s*\n", text.strip()):
        if tokens:
            tokens.append({"br": True})
        for raw in para.split():
            n = norm(raw)
            if not n:
                tokens.append({"t": raw})
                continue
            tokens.append({"t": raw, "i": len(words)})
            words.append(n)
    return tokens, words


# ---------- alignment ----------

def sim(a, b):
    if a == b:
        return 1.0
    if not a or not b:
        return 0.0
    return SequenceMatcher(None, a, b).ratio()


def align(heard, script, lo, hi):
    """Smith-Waterman between the heard tail and script[lo:hi].
    Returns (score, index of the script word the alignment ends on)."""
    seg = script[lo:hi]
    n, m = len(heard), len(seg)
    if not n or not m:
        return 0.0, None
    H = np.zeros((n + 1, m + 1))
    best, best_j = 0.0, None
    for i in range(1, n + 1):
        h = heard[i - 1]
        for j in range(1, m + 1):
            s = sim(h, seg[j - 1])
            match = 2.0 if s >= 0.85 else 1.0 if s >= 0.6 else -1.0
            v = max(0.0, H[i - 1, j - 1] + match, H[i - 1, j] - 1.0, H[i, j - 1] - 0.7)
            H[i, j] = v
            # Only credit alignments that reach the most recent heard word,
            # otherwise stale words keep pulling the position around.
            if i == n and v > best:
                best, best_j = v, lo + j - 1
    return best, best_j


class Tracker:
    TAIL = 8          # heard words used for matching
    BACK, AHEAD = 12, 60
    MIN_SCORE = 3.5   # about two matched words
    JUMP_SCORE = 7.5  # about four exact words in a row, to relocate outside the local window

    def __init__(self, script):
        self.script = script
        self.pos = 0  # index of the next word to read
        self.off_script = False

    def update(self, heard):
        tail = heard[-self.TAIL:]
        lo, hi = max(0, self.pos - self.BACK), min(len(self.script), self.pos + self.AHEAD)
        score, j = align(tail, self.script, lo, hi)
        # Prefer nearby positions: a tiny penalty for distance from where we were.
        if j is not None:
            score -= 0.03 * abs(j + 1 - self.pos)
        if j is None or score < self.MIN_SCORE:
            g_score, g_j = align(tail, self.script, 0, len(self.script))
            if g_j is not None and g_score >= self.JUMP_SCORE:
                score, j = g_score, g_j
            else:
                self.off_script = len(tail) >= 3
                return
        self.off_script = False
        self.pos = j + 1


# ---------- ASR ----------

def make_recognizer(threads):
    d = glob.glob(os.path.join(ROOT, "models", "sherpa-onnx-streaming-zipformer-en-*"))[0]
    pick = lambda name: (glob.glob(f"{d}/{name}*int8.onnx") or glob.glob(f"{d}/{name}*.onnx"))[0]
    return sherpa_onnx.OnlineRecognizer.from_transducer(
        tokens=f"{d}/tokens.txt",
        encoder=pick("encoder"), decoder=pick("decoder"), joiner=pick("joiner"),
        num_threads=threads, sample_rate=RATE, feature_dim=80,
        decoding_method="greedy_search",
        enable_endpoint_detection=True,
        rule1_min_trailing_silence=2.0, rule2_min_trailing_silence=0.8, rule3_min_utterance_length=20,
    )


def words_with_times(result, seg_offset):
    """Group BPE tokens into words, each with the stream time of its last token
    (roughly when the word ended)."""
    out = []
    for tok, ts in zip(result.tokens, result.timestamps):
        starts = tok.startswith(" ") or tok.startswith("▁") or not out
        piece = tok.lstrip(" ▁")
        if starts:
            out.append([piece, seg_offset + ts])
        else:
            out[-1][0] += piece
            out[-1][1] = seg_offset + ts
    return [(norm(w), t) for w, t in out if norm(w)]


# ---------- shared state + web ----------

state = {"pos": 0, "heard": "", "off": False, "lat_ms": None, "lat_p50": None, "rtf": None, "v": 0}
cond = threading.Condition()
TOKENS = []


def publish(**kw):
    with cond:
        state.update(kw)
        state["v"] += 1
        cond.notify_all()


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def do_GET(self):
        if self.path == "/":
            body = open(os.path.join(HERE, "index.html"), "rb").read()
            self.send_response(200); self.send_header("Content-Type", "text/html; charset=utf-8")
            self.end_headers(); self.wfile.write(body)
        elif self.path == "/script":
            body = json.dumps(TOKENS).encode()
            self.send_response(200); self.send_header("Content-Type", "application/json")
            self.end_headers(); self.wfile.write(body)
        elif self.path == "/events":
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream"); self.send_header("Cache-Control", "no-cache")
            self.end_headers()
            seen = -1
            try:
                while True:
                    with cond:
                        cond.wait_for(lambda: state["v"] != seen, timeout=15)
                        seen, snap = state["v"], dict(state)
                    self.wfile.write(f"data: {json.dumps(snap)}\n\n".encode()); self.wfile.flush()
            except (BrokenPipeError, ConnectionResetError):
                pass
        else:
            self.send_error(404)


def main():
    global TOKENS
    ap = argparse.ArgumentParser()
    ap.add_argument("script")
    ap.add_argument("--mic", default="omarchy_asahi_mic")
    ap.add_argument("--threads", type=int, default=2)
    ap.add_argument("--port", type=int, default=8765)
    args = ap.parse_args()

    TOKENS, script_words = load_script(args.script)
    tracker = Tracker(script_words)
    rec = make_recognizer(args.threads)
    stream = rec.create_stream()

    srv = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    print(f"Teleprompter at http://localhost:{args.port}  ({len(script_words)} script words)", file=sys.stderr)

    parec = subprocess.Popen(
        ["parec", f"--device={args.mic}", f"--rate={RATE}", "--channels=1", "--format=s16le", "--latency-msec=20"],
        stdout=subprocess.PIPE)

    fed = 0.0          # seconds of audio given to the recognizer
    seg_offset = 0.0   # stream time where the current segment began
    done = []          # finished segments' words
    seen_words = 0     # words of the current segment already timed
    lats, busy = [], 0.0
    t_start = time.monotonic()
    try:
        while True:
            raw = parec.stdout.read(CHUNK * 2)
            if not raw:
                break
            t0 = time.monotonic()
            samples = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768
            stream.accept_waveform(RATE, samples)
            fed += len(samples) / RATE
            while rec.is_ready(stream):
                rec.decode_stream(stream)
            res = rec.get_result_all(stream)
            cur = words_with_times(res, seg_offset)
            busy += time.monotonic() - t0

            changed = False
            if len(cur) > seen_words:
                # Latency of a new word: audio fed so far minus when the word ended.
                # (Includes the model's lookahead; excludes the ~20 ms capture buffer.)
                for w, t in cur[seen_words:]:
                    lats.append((fed - t) * 1000)
                seen_words = len(cur)
                changed = True

            if rec.is_endpoint(stream):
                done.extend(w for w, _ in cur)
                done = done[-50:]
                rec.reset(stream)
                seg_offset, seen_words, cur = fed, 0, []

            if changed:
                heard = done + [w for w, _ in cur]
                tracker.update(heard)
                wall = time.monotonic() - t_start
                recent = lats[-30:]
                publish(pos=tracker.pos, off=tracker.off_script, heard=" ".join(heard[-14:]),
                        lat_ms=round(lats[-1]), lat_p50=round(statistics.median(recent)),
                        rtf=round(busy / max(wall, 1e-6), 3))
                print(f"pos={tracker.pos:4d} lat={lats[-1]:5.0f}ms p50={statistics.median(recent):5.0f}ms "
                      f"cpu={busy / wall:.2f}  {' '.join(heard[-8:])}", file=sys.stderr)
    except KeyboardInterrupt:
        pass
    finally:
        parec.terminate()


if __name__ == "__main__":
    main()
