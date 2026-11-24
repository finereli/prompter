# Prompter

A teleprompter that listens to you. You read, and the text keeps up. When you go off script, it waits. When you come back, it finds you.

**Try it: [prompter.finereli.com](https://prompter.finereli.com)**

I made it to record videos without sounding like I'm reading. Every teleprompter I'd tried scrolled at a fixed speed, so I either chased the text or waited for it, and the moment I said something that wasn't in the script I was lost. A year or two ago, making the text follow your voice was a research project. Now speech recognition runs in a browser tab fast enough to keep up, and the rest is a small alignment algorithm.

## What it does

- **Follows your voice.** Words are recognized about a quarter of a second after you say them, and the next word to read sits on a fixed line near the top of the screen, close to the camera.
- **Lets you go off script.** Paraphrase a sentence and it still follows. Tell a story that isn't in the script and the text holds still and says "off script". Come back mid-paragraph and it picks you up within a few words.
- **Handles retakes.** Start a sentence over, or jump back a paragraph, and it follows you there.
- **Records you while you read.** Camera and mic go into one video, and each take also gets a `.json` timeline of where you were in the script, second by second. That timeline is meant for editing later: finding retakes, tangents and dead air.
- **Saves into a folder.** In Chromium-based browsers you pick a folder once and takes are written into it as they record. Other browsers download them.
- **Stays on your machine.** Speech recognition runs locally in WebAssembly. Your voice and video never leave your computer, and there is no account and no server-side code.

The controls are three buttons: **Prompter** (Space) turns voice-following on and off, **Record** (R) records, and **Restart** (Home) takes the prompter back to the top without stopping the recording. The arrow keys nudge the position by hand, and `[` and `]` change the column width.

## How it works

Speech recognition is [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx) running a streaming Zipformer transducer, compiled to WebAssembly. An AudioWorklet feeds it the mic in 50 ms chunks.

The interesting part is [`web/align.js`](web/align.js), which decides where you are. After each recognized word it takes the last eight words you said and aligns them against the script near your current position, using Smith-Waterman local alignment over words with fuzzy matching, so "gonna" can still match "going". A few rules make it behave:

- An alignment only counts if it ends on the word you just said, so a phrase you finished a while ago can't keep pulling the position along while you talk about something else.
- Small steps forward are accepted at once. A jump of more than three words waits for the next word to agree, because one misheard word ("they" for "the") can make a spot further on look like the best match for a moment.
- When nothing nearby matches, it searches the whole script, but relocating there takes about four exact words in a row.

## Run it locally

The speech model is too big for git. Fetch sherpa-onnx's WebAssembly bundle and the English streaming model once, then pack them:

    mkdir -p vendor models
    (cd vendor && gh release download v1.13.7 -R k2-fsa/sherpa-onnx -p "sherpa-onnx-wasm-simd-v1.13.7-en-asr-zipformer.tar.bz2" && tar xjf *.tar.bz2 && rm *.tar.bz2)
    (cd models && curl -LO https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-streaming-zipformer-en-2023-06-26.tar.bz2 && tar xjf *.tar.bz2 && rm *.tar.bz2)
    python3 scripts/pack-model.py

The bundle preloads its model from one `.data` file with a list of byte offsets in the loader script. `pack-model.py` swaps in the int8 build of the model, which cuts the download from 191 MB to 72 MB, and writes everything to `web/sherpa/`.

Then serve `web/` and open http://127.0.0.1:8766:

    cd web && python3 serve.py

`serve.py` is a plain static server with caching turned off, so a reload always picks up your edits.

## Deploy

It runs on Cloudflare as static assets plus a tiny Worker. The model file (72 MB) is over the 25 MiB limit for static assets, so it lives in R2 and the Worker serves it with a year-long cache header. That's also why the file name changes whenever the model does.

    wrangler r2 bucket create prompter-models
    wrangler r2 object put prompter-models/prompter-en-2023-06-26-int8.data \
      --file web/sherpa/prompter-en-2023-06-26-int8.data --remote
    wrangler deploy

Change the `account_id` and the route in `wrangler.jsonc` to your own.

## Layout

- `web/` is the app. `align.js` is the aligner, `app.js` the rest, and `mic-worklet.js` the audio thread.
- `worker.js` serves the model from R2.
- `scripts/pack-model.py` builds the speech model bundle.
- `proto/` holds the first prototype: native sherpa-onnx in Python, pushing positions to a page over server-sent events.
- `studio/` holds an experiment in local background replacement with Robust Video Matting. It works, but it can't fix bad lighting, which turned out to be the real problem.

## Ideas

Things I'd like to see, if you feel like building one:

- **More languages.** sherpa-onnx has streaming models for Chinese and other languages, and the aligner only assumes words separated by spaces.
- **Editing from the timeline.** Each take's `.json` says where you were in the script at every moment. That's enough to cut retakes and dead air automatically.
- **An installable PWA**, so it opens in its own window.
- **A pace for silent stretches**, so the text can creep forward through a pause you planned.

## License

MIT. The speech model and sherpa-onnx are Apache 2.0, from the [k2-fsa](https://github.com/k2-fsa) project.
