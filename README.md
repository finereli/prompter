# Prompter

A teleprompter that follows your voice, and records you while you read.

Speech recognition runs in the browser (sherpa-onnx compiled to WebAssembly), so nothing leaves your machine. The text keeps your place as you read: paraphrases still match, it holds while you go off on a tangent, and it picks up again when you come back or start a sentence over.

Each take downloads as a video plus a `.json` timeline of where you were in the script, for editing later.

## Run

The speech model isn't in the repo. Fetch it once:

    mkdir -p vendor && cd vendor
    gh release download v1.13.7 -R k2-fsa/sherpa-onnx -p "sherpa-onnx-wasm-simd-v1.13.7-en-asr-zipformer.tar.bz2"
    tar xjf *.tar.bz2 && rm *.tar.bz2

Then serve `web/` and open http://127.0.0.1:8766:

    cd web && python3 serve.py

Keys: `R` record, `↑`/`↓` nudge, `Home` back to top, `V` camera, `[` `]` column width.

## Layout

- `web/` - the app. `align.js` holds the place-keeping algorithm.
- `proto/` - the first Python prototype (native sherpa-onnx, page served over SSE).
