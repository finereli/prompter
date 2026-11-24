#!/usr/bin/env python3
"""Repack the browser speech model with the int8 English streaming Zipformer.

sherpa-onnx's prebuilt WebAssembly bundle preloads one .data file holding
encoder.onnx, decoder.onnx, joiner.onnx and tokens.txt back to back, and the
loader script lists each file's byte range. Swapping the model means
concatenating new files and rewriting that list; nothing has to be rebuilt.

The int8 encoder is 70 MB instead of 188 MB. The decoder stays full precision
(it's 2 MB either way), following sherpa-onnx's own advice for this bundle.
The output gets a new name because browsers cache the model file for a year.

Usage: python3 scripts/pack-model.py
Reads vendor/ and models/ (see README), writes web/sherpa/ (generated, not in git).
"""
import glob, json, os, re, shutil

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BUNDLE = glob.glob(os.path.join(ROOT, "vendor", "sherpa-onnx-wasm-simd-*-en-asr-zipformer"))[0]
MODEL = os.path.join(ROOT, "models", "sherpa-onnx-streaming-zipformer-en-2023-06-26")
OUT = os.path.join(ROOT, "web", "sherpa")
DATA_NAME = "prompter-en-2023-06-26-int8.data"

files = [  # (name inside the bundle, source file)
    ("/decoder.onnx", f"{MODEL}/decoder-epoch-99-avg-1-chunk-16-left-128.onnx"),
    ("/encoder.onnx", f"{MODEL}/encoder-epoch-99-avg-1-chunk-16-left-128.int8.onnx"),
    ("/joiner.onnx", f"{MODEL}/joiner-epoch-99-avg-1-chunk-16-left-128.int8.onnx"),
    ("/tokens.txt", f"{MODEL}/tokens.txt"),
]

os.makedirs(OUT, exist_ok=True)
entries, offset = [], 0
with open(os.path.join(OUT, DATA_NAME), "wb") as out:
    for name, src in files:
        data = open(src, "rb").read()
        out.write(data)
        entries.append({"filename": name, "start": offset, "end": offset + len(data)})
        offset += len(data)

loader = open(os.path.join(BUNDLE, "sherpa-onnx-wasm-main-asr.js")).read()
listing = "loadPackage({files:" + json.dumps(entries, separators=(",", ":")).replace('"filename"', "filename") \
    .replace('"start"', "start").replace('"end"', "end") + f",remote_package_size:{offset}}})"
loader, n = re.subn(r"loadPackage\(\{files:\[.*?\],remote_package_size:\d+\}\)", lambda m: listing, loader, count=1)
assert n == 1, "file listing not found in the loader"
assert loader.count("sherpa-onnx-wasm-main-asr.data") >= 1, "data file name not found in the loader"
loader = loader.replace("sherpa-onnx-wasm-main-asr.data", DATA_NAME)
open(os.path.join(OUT, "sherpa-onnx-wasm-main-asr.js"), "w").write(loader)

for f in ("sherpa-onnx-asr.js", "sherpa-onnx-wasm-main-asr.wasm"):
    shutil.copyfile(os.path.join(BUNDLE, f), os.path.join(OUT, f))

print(f"{DATA_NAME}: {offset / 1e6:.1f} MB")
for e in entries:
    print(f"  {e['filename']:14s} {(e['end'] - e['start']) / 1e6:7.2f} MB")
