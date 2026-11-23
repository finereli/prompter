import { parseScript, norm, Tracker } from './align.js';

const $ = id => document.getElementById(id);
const RATE = 16000;

// ---------- script display ----------

let spans = [], tracker = null, lastPos = -1;

function loadScript(text) {
  localStorage.setItem('prompter.script', text);
  const { tokens, words } = parseScript(text);
  tracker = new Tracker(words);
  const root = $('text');
  root.textContent = '';
  spans = [];
  let p = document.createElement('p');
  root.appendChild(p);
  for (const tok of tokens) {
    if (tok.br) { p = document.createElement('p'); root.appendChild(p); continue; }
    const s = document.createElement('span');
    s.textContent = tok.t;
    if (tok.i !== undefined) { s.className = 'w'; spans[tok.i] = s; }
    p.append(s, ' ');
  }
  lastPos = -1;
  showPos(0);
}

function showPos(pos) {
  if (pos === lastPos) return;
  const from = Math.max(0, Math.min(pos, lastPos < 0 ? 0 : lastPos) - 1);
  const to = Math.max(pos, lastPos) + 1;
  for (let i = lastPos < 0 ? 0 : from; i < (lastPos < 0 ? spans.length : Math.min(to, spans.length)); i++) {
    spans[i].classList.toggle('done', i < pos);
    spans[i].classList.toggle('cur', i === pos);
  }
  lastPos = pos;
  const target = spans[Math.min(pos, spans.length - 1)];
  if (!target) return;
  // Keep the next word on the guide line, near the top so your eyes stay close to the camera.
  const vp = $('viewport');
  const guide = vp.clientHeight * parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--guide') || 22) / 100;
  $('text').style.top = (guide - target.offsetTop - target.offsetHeight / 2 + 1) + 'px';
}

function setPos(pos) {
  if (!tracker) return;
  tracker.pos = Math.max(0, Math.min(pos, spans.length));
  showPos(tracker.pos);
}

// ---------- speech recognition ----------

let recognizer = null, asrStream = null;
let fed = 0, segOffset = 0, seenWords = 0, done = [];
let lats = [], busy = 0;
let timeline = null;   // per-recording log of where the reader was, for the edit step later

function wordsWithTimes(r) {
  const out = [];
  const toks = r.tokens || [], ts = r.timestamps || [];
  for (let k = 0; k < toks.length; k++) {
    const tok = toks[k], t = segOffset + (ts[k] ?? 0);
    const starts = tok.startsWith(' ') || tok.startsWith('▁') || !out.length;
    const piece = tok.replace(/^[ ▁]+/, '');
    if (starts) out.push([piece, t]);
    else { out[out.length - 1][0] += piece; out[out.length - 1][1] = t; }
  }
  return out.map(([w, t]) => [norm(w), t]).filter(([w]) => w);
}

function onAudio(samples) {
  const t0 = performance.now();
  asrStream.acceptWaveform(RATE, samples);
  fed += samples.length / RATE;
  while (recognizer.isReady(asrStream)) recognizer.decode(asrStream);
  const cur = wordsWithTimes(recognizer.getResult(asrStream));

  let changed = false;
  if (cur.length > seenWords) {
    // Delay of each new word: audio heard so far minus when the word ended.
    for (const [, t] of cur.slice(seenWords)) lats.push((fed - t) * 1000);
    seenWords = cur.length;
    changed = true;
  }
  if (recognizer.isEndpoint(asrStream)) {
    done.push(...cur.map(([w]) => w));
    done = done.slice(-50);
    recognizer.reset(asrStream);
    segOffset = fed; seenWords = 0; cur.length = 0;
  }
  if (changed) {
    const heard = done.concat(cur.map(([w]) => w));
    tracker.update(heard);
    showPos(tracker.pos);
    $('off').style.visibility = tracker.offScript ? 'visible' : 'hidden';
    $('heard').textContent = heard.slice(-14).join(' ');
    const recent = lats.slice(-30).sort((a, b) => a - b);
    $('lat').textContent = Math.round(lats[lats.length - 1]);
    $('p50').textContent = Math.round(recent[recent.length >> 1]);
    if (timeline) timeline.push({ t: +(performance.now() / 1000 - timeline.t0).toFixed(3), pos: tracker.pos, off: tracker.offScript, heard: heard[heard.length - 1] });
  }
  busy += performance.now() - t0;
  if (fed > 0) $('cpu').textContent = (busy / 1000 / fed).toFixed(3);
}

// ---------- devices ----------

let media = null, audioCtx = null;

async function start() {
  $('startBtn').disabled = true;
  $('startBtn').textContent = 'Starting…';
  media = await navigator.mediaDevices.getUserMedia({
    video: { width: { ideal: 1920 }, height: { ideal: 1440 }, frameRate: { ideal: 30 } },
    // Keep the voice untouched for the recording; recognition copes fine.
    audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
  });
  $('cam').srcObject = media;
  $('cam').classList.remove('hidden');

  audioCtx = new AudioContext({ sampleRate: RATE });
  await audioCtx.audioWorklet.addModule('mic-worklet.js');
  const node = new AudioWorkletNode(audioCtx, 'mic-chunker');
  node.port.onmessage = e => onAudio(e.data);
  audioCtx.createMediaStreamSource(new MediaStream(media.getAudioTracks())).connect(node);

  asrStream = recognizer.createStream();
  const v = media.getVideoTracks()[0].getSettings();
  $('status').textContent = `${v.width}×${v.height} @ ${Math.round(v.frameRate)} fps`;
  $('startBtn').textContent = 'Listening';
  $('recBtn').disabled = false;
}

// ---------- recording ----------

let recorder = null, chunks = [], recStart = 0, timerId = 0;

function pickMime() {
  const options = ['video/mp4;codecs=avc1.640028,mp4a.40.2', 'video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm'];
  return options.find(m => MediaRecorder.isTypeSupported(m)) || '';
}

function stamp() {
  const d = new Date(), p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function download(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}

function toggleRecord() {
  if (!media) return;
  if (recorder) { recorder.stop(); return; }
  const mimeType = pickMime();
  recorder = new MediaRecorder(media, { mimeType, videoBitsPerSecond: 8_000_000, audioBitsPerSecond: 192_000 });
  chunks = [];
  recorder.ondataavailable = e => e.data.size && chunks.push(e.data);
  recorder.onstop = () => {
    const ext = recorder.mimeType.includes('mp4') ? 'mp4' : 'webm';
    const name = `prompter-${stamp()}`;
    download(new Blob(chunks, { type: recorder.mimeType }), `${name}.${ext}`);
    // The script and where you were in it over time, for the edit step.
    timeline.script = localStorage.getItem('prompter.script');
    download(new Blob([JSON.stringify(timeline)], { type: 'application/json' }), `${name}.json`);
    recorder = null; timeline = null;
    clearInterval(timerId);
    $('timer').textContent = '';
    $('recBtn').classList.remove('on');
    $('recBtn').textContent = '● Record';
  };
  recorder.start(1000);
  timeline = { t0: performance.now() / 1000, mime: recorder.mimeType, events: [] };
  timeline.push = ev => timeline.events.push(ev);
  recStart = Date.now();
  timerId = setInterval(() => {
    const s = Math.floor((Date.now() - recStart) / 1000);
    $('timer').textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  }, 250);
  $('recBtn').classList.add('on');
  $('recBtn').textContent = '■ Stop';
  $('status').textContent = `recording ${recorder.mimeType.split(';')[0]}`;
}

// ---------- UI ----------

function openEditor() {
  $('scriptText').value = localStorage.getItem('prompter.script') || '';
  $('editor').classList.add('open');
  $('scriptText').focus();
}

$('scriptBtn').onclick = openEditor;
$('cancelEdit').onclick = () => $('editor').classList.remove('open');
$('saveEdit').onclick = () => { loadScript($('scriptText').value); $('editor').classList.remove('open'); };
$('startBtn').onclick = () => start().catch(e => { $('status').textContent = e.message; $('startBtn').disabled = false; $('startBtn').textContent = 'Start'; });
$('recBtn').onclick = toggleRecord;
$('camBtn').onclick = () => $('cam').classList.toggle('hidden');

// Camera preview: drag to move, scroll over it to resize. Remembered between sessions.
(function camPreview() {
  const cam = $('cam');
  const clamp = () => {
    // Read our own style values: a hidden element reports zero for its layout.
    const w = parseFloat(cam.style.width) || 240, h = w * 0.75;
    const x = Math.max(0, Math.min(parseFloat(cam.style.left) || 0, innerWidth - w));
    const y = Math.max(0, Math.min(parseFloat(cam.style.top) || 0, innerHeight - h));
    cam.style.left = x + 'px'; cam.style.top = y + 'px';
  };
  const save = () => localStorage.setItem('prompter.cam', JSON.stringify(
    { x: parseFloat(cam.style.left) / innerWidth, y: parseFloat(cam.style.top) / innerHeight, w: parseFloat(cam.style.width) }));
  const restore = () => {
    const s = JSON.parse(localStorage.getItem('prompter.cam') || 'null');
    cam.style.width = (s?.w || 240) + 'px';
    // Default: bottom right, away from the reading line near the top.
    const h = (s?.w || 240) * 0.75;
    cam.style.left = (s ? s.x * innerWidth : innerWidth - (s?.w || 240) - 16) + 'px';
    cam.style.top = (s ? s.y * innerHeight : innerHeight - h - 72) + 'px';
    clamp();
  };
  let drag = null;
  cam.addEventListener('pointerdown', e => {
    drag = { dx: e.clientX - cam.offsetLeft, dy: e.clientY - cam.offsetTop };
    cam.setPointerCapture(e.pointerId); cam.classList.add('dragging');
  });
  cam.addEventListener('pointermove', e => {
    if (!drag) return;
    cam.style.left = (e.clientX - drag.dx) + 'px'; cam.style.top = (e.clientY - drag.dy) + 'px';
  });
  const end = () => { if (!drag) return; drag = null; cam.classList.remove('dragging'); clamp(); save(); };
  cam.addEventListener('pointerup', end);
  cam.addEventListener('pointercancel', end);
  cam.addEventListener('wheel', e => {
    e.preventDefault();
    const w = Math.max(120, Math.min(innerWidth * 0.6, parseFloat(cam.style.width) * (e.deltaY < 0 ? 1.08 : 1 / 1.08)));
    cam.style.width = w + 'px'; clamp(); save();
  }, { passive: false });
  addEventListener('resize', restore);
  restore();
})();
$('mirrorBtn').onclick = () => $('text').classList.toggle('mirror');

function fontSize(delta) {
  const cur = parseInt(localStorage.getItem('prompter.fs') || '52');
  const next = Math.max(24, Math.min(120, cur + delta));
  localStorage.setItem('prompter.fs', next);
  document.documentElement.style.setProperty('--fs', next + 'px');
  const pos = lastPos; lastPos = -1; showPos(Math.max(0, pos));
}
// Column width in em, so it keeps the same words per line at any text size.
function columnWidth(delta) {
  const cur = parseFloat(localStorage.getItem('prompter.col') || '15');
  const next = Math.max(8, Math.min(30, cur + delta));
  localStorage.setItem('prompter.col', next);
  document.documentElement.style.setProperty('--col', next + 'em');
  const pos = lastPos; lastPos = -1; showPos(Math.max(0, pos));
}
$('narrower').onclick = () => columnWidth(-1);
$('wider').onclick = () => columnWidth(1);
columnWidth(0);
$('smaller').onclick = () => fontSize(-6);
$('bigger').onclick = () => fontSize(6);
fontSize(0);

document.addEventListener('keydown', e => {
  if ($('editor').classList.contains('open')) { if (e.key === 'Escape') $('editor').classList.remove('open'); return; }
  // Leave browser shortcuts alone: Ctrl+R must reload, not start a take.
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.key === 'r' || e.key === 'R') toggleRecord();
  else if (e.key === 'v' || e.key === 'V') $('cam').classList.toggle('hidden');
  else if (e.key === 'ArrowDown') setPos(tracker.pos + 5);
  else if (e.key === 'ArrowUp') setPos(tracker.pos - 5);
  else if (e.key === 'Home') setPos(0);
  else if (e.key === '[') columnWidth(-1);
  else if (e.key === ']') columnWidth(1);
  else return;
  e.preventDefault();
});

document.addEventListener('dragover', e => e.preventDefault());
document.addEventListener('drop', async e => {
  e.preventDefault();
  const f = e.dataTransfer.files[0];
  if (f) loadScript(await f.text());
});
window.addEventListener('resize', () => { const p = lastPos; lastPos = -1; showPos(Math.max(0, p)); });

// ---------- boot ----------

const saved = localStorage.getItem('prompter.script');
if (saved) loadScript(saved);
else fetch('sample.md').then(r => r.text()).then(loadScript);

window.sherpaReady.then(() => {
  recognizer = createOnlineRecognizer(Module);
  $('status').textContent = '';
  $('startBtn').disabled = false;
  $('startBtn').textContent = 'Start';
});

// Test hook: ?autostart begins listening without a click and logs stats.
if (new URLSearchParams(location.search).has('autostart')) {
  window.sherpaReady.then(() => start()).then(() => {
    setInterval(() => console.log('STATS', JSON.stringify({
      fed: +fed.toFixed(1), cpu: +(busy / 1000 / Math.max(fed, 1e-6)).toFixed(3),
      p50: Math.round([...lats].sort((a, b) => a - b)[lats.length >> 1] || 0),
      max: Math.round(Math.max(0, ...lats)), words: lats.length, pos: tracker.pos,
      heard: $('heard').textContent })), 3000);
  }).catch(e => console.log('ERR', e.message));
}
