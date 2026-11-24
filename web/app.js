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

// Forget what was heard, so old words can't pull the position anywhere.
function forgetHeard() {
  done = []; seenWords = 0;
  if (asrStream) { recognizer.reset(asrStream); segOffset = fed; }
  if (tracker) { tracker.pending = null; tracker.offScript = false; }
  $('off').style.visibility = 'hidden';
  $('heard').textContent = '';
}

// Back to the top of the script. Leaves the prompter on or off, and any recording running.
function restart() {
  if (!tracker) return;
  forgetHeard();
  setPos(0);
}

// The prompter follows your voice only while it's on. It starts off; pausing keeps your place.
let following = false;
async function togglePrompter() {
  if (!recognizer) return;
  if (!following) {
    try { await start(); } catch { return; }
    if (audioCtx.state === 'suspended') await audioCtx.resume();
    forgetHeard();  // whatever you said while it was paused shouldn't count
  }
  following = !following;
  $('promptBtn').textContent = following ? '⏸ Prompter' : '▶ Prompter';
  $('promptBtn').classList.toggle('on', following);
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
  if (!following) return;
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

// Opens camera and mic and starts listening. Safe to call more than once.
let starting = null;
function start() {
  starting ??= openDevices().catch(e => { starting = null; $('status').textContent = e.message; throw e; });
  return starting;
}

async function openDevices() {
  $('status').textContent = 'Starting camera and mic…';
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
  const ready = `${v.width}×${v.height} @ ${Math.round(v.frameRate)} fps`;
  // Opened on page load, Chrome keeps audio paused until the first click or key.
  if (audioCtx.state === 'suspended') {
    $('status').textContent = 'Click anywhere or press a key to start listening';
    const wake = () => audioCtx.resume().then(() => { $('status').textContent = ready; });
    addEventListener('pointerdown', wake, { once: true });
    addEventListener('keydown', wake, { once: true });
  } else $('status').textContent = ready;
}

// Camera and mic open on load when you've allowed them before; otherwise the
// first Record asks.
async function autoStart() {
  try {
    const q = name => navigator.permissions.query({ name }).then(r => r.state);
    const [cam, mic] = await Promise.all([q('camera'), q('microphone')]);
    if (cam === 'granted' && mic === 'granted') return start();
  } catch {}
  $('status').textContent = 'Press Record to allow camera and mic';
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

// ---------- save folder ----------
// Chromium can write straight into a folder you pick once (File System Access).
// The handle lives in IndexedDB so the choice survives reloads. Other browsers
// fall back to downloads.

const canPickFolder = 'showDirectoryPicker' in window;
let folder = null;

function idb(mode, fn) {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open('prompter', 1);
    open.onupgradeneeded = () => open.result.createObjectStore('kv');
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const tx = open.result.transaction('kv', mode);
      const req = fn(tx.objectStore('kv'));
      tx.oncomplete = () => resolve(req && req.result);
      tx.onerror = () => reject(tx.error);
    };
  });
}

function showFolder() {
  $('folderBtn').textContent = folder ? `Saving to ${folder.name}` : 'Choose folder';
  $('folderBtn').title = folder ? 'Takes are written into this folder. Click to change.' : 'Takes download until you pick a folder';
}

async function chooseFolder() {
  try {
    folder = await window.showDirectoryPicker({ id: 'prompter-takes', mode: 'readwrite' });
    await idb('readwrite', st => st.put(folder, 'folder'));
  } catch (e) { if (e.name !== 'AbortError') $('status').textContent = e.message; }
  showFolder();
}

// Needs a click or key press when the browser asks again after a reload,
// which pressing Record provides.
async function folderReady() {
  if (!folder) return false;
  const opts = { mode: 'readwrite' };
  if (await folder.queryPermission(opts) === 'granted') return true;
  return await folder.requestPermission(opts) === 'granted';
}

async function writeFile(name, blob) {
  if (folder && await folderReady()) {
    const w = await (await folder.getFileHandle(name, { create: true })).createWritable();
    await w.write(blob); await w.close();
  } else download(blob, name);
}

// ---------- recording ----------

async function toggleRecord() {
  if (!recognizer) return;
  if (recorder) { recorder.stop(); return; }
  if (!media) {
    try { await start(); } catch { return; }
    // Chrome may hold the audio until a gesture; this click or key press is one.
    if (audioCtx.state === 'suspended') await audioCtx.resume();
  }
  const mimeType = pickMime();
  const ext = mimeType.includes('mp4') ? 'mp4' : 'webm';
  const name = `prompter-${stamp()}`;

  // With a folder, stream each second of video into the file as it records, so
  // a long take never piles up in memory. Without one, collect and download.
  let sink = null, writing = Promise.resolve();
  if (await folderReady()) {
    try { sink = await (await folder.getFileHandle(`${name}.${ext}`, { create: true })).createWritable(); }
    catch (e) { $('status').textContent = `Can't write to ${folder.name}: ${e.message}`; }
  }
  recorder = new MediaRecorder(media, { mimeType, videoBitsPerSecond: 8_000_000, audioBitsPerSecond: 192_000 });
  chunks = [];
  recorder.ondataavailable = e => {
    if (!e.data.size) return;
    if (sink) writing = writing.then(() => sink.write(e.data));
    else chunks.push(e.data);
  };
  recorder.onstop = async () => {
    const type = recorder.mimeType;
    if (sink) { await writing; await sink.close(); }
    else download(new Blob(chunks, { type }), `${name}.${ext}`);
    // The script and where you were in it over time, for the edit step.
    timeline.script = localStorage.getItem('prompter.script');
    await writeFile(`${name}.json`, new Blob([JSON.stringify(timeline)], { type: 'application/json' }));
    $('status').textContent = sink ? `Saved ${name}.${ext} to ${folder.name}` : `Downloaded ${name}.${ext}`;
    recorder = null; timeline = null; chunks = [];
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
  $('status').textContent = `recording ${recorder.mimeType.split(';')[0]}${sink ? ' to ' + folder.name : ''}`;
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
$('recBtn').onclick = toggleRecord;
$('promptBtn').onclick = togglePrompter;
// A clicked button keeps focus, and Space would then press it as well as run the shortcut.
document.addEventListener('click', e => { if (e.target.closest('#top button')) e.target.closest('button').blur(); });
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
$('restartBtn').onclick = restart;
if (canPickFolder) {
  $('folderBtn').onclick = chooseFolder;
  idb('readonly', st => st.get('folder')).then(h => { folder = h || null; showFolder(); }).catch(showFolder);
} else $('folderBtn').hidden = true;

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
  else if (e.key === ' ') togglePrompter();
  else if (e.key === 'v' || e.key === 'V') $('cam').classList.toggle('hidden');
  else if (e.key === 'ArrowDown') setPos(tracker.pos + 5);
  else if (e.key === 'ArrowUp') setPos(tracker.pos - 5);
  else if (e.key === 'Home') restart();
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
  document.getElementById('progress').style.display = 'none';
  $('recBtn').disabled = false;
  $('promptBtn').disabled = false;
  if (!new URLSearchParams(location.search).has('autostart')) autoStart();
});

// Test hook: ?autostart begins listening without a click and logs stats.
if (new URLSearchParams(location.search).has('autostart')) {
  window.sherpaReady.then(() => togglePrompter()).then(() => {
    setInterval(() => console.log('STATS', JSON.stringify({
      fed: +fed.toFixed(1), cpu: +(busy / 1000 / Math.max(fed, 1e-6)).toFixed(3),
      p50: Math.round([...lats].sort((a, b) => a - b)[lats.length >> 1] || 0),
      max: Math.round(Math.max(0, ...lats)), words: lats.length, pos: tracker.pos,
      heard: $('heard').textContent })), 3000);
  }).catch(e => console.log('ERR', e.message));
}
