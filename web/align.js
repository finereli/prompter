// Keeps the reader's place in a script by fuzzy-aligning the last few words
// heard against the script near the current position (Smith-Waterman over
// words). Paraphrases still match, tangents match nothing so the position
// holds, and a few exact words in a row anywhere relocate it.

export function norm(w) {
  return w.toLowerCase().replace(/’/g, "'").replace(/[^a-z0-9']/g, '');
}

// Split a script into display tokens (with paragraph breaks) and the
// normalized words the aligner works on. Token.i indexes into words.
export function parseScript(text) {
  const tokens = [], words = [];
  const paras = text.trim().split(/\n\s*\n/);
  paras.forEach((para, pi) => {
    if (pi) tokens.push({ br: true });
    for (const raw of para.split(/\s+/).filter(Boolean)) {
      const n = norm(raw);
      if (n) { tokens.push({ t: raw, i: words.length }); words.push(n); }
      else tokens.push({ t: raw });
    }
  });
  return { tokens, words };
}

function lev(a, b) {
  const m = a.length, n = b.length;
  let prev = Array.from({ length: n + 1 }, (_, j) => j), cur = new Array(n + 1);
  for (let i = 1; i <= m; i++) {
    cur[0] = i;
    for (let j = 1; j <= n; j++)
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    [prev, cur] = [cur, prev];
  }
  return prev[n];
}

function sim(a, b) {
  if (a === b) return 1;
  if (!a || !b) return 0;
  return 1 - lev(a, b) / Math.max(a.length, b.length);
}

// Best local alignment of heard against script[lo:hi] that ends on the last
// heard word. Returns {score, j} with j the script index it ends on.
function align(heard, script, lo, hi) {
  const n = heard.length, m = hi - lo;
  if (!n || m <= 0) return { score: 0, j: null };
  let prev = new Float64Array(m + 1), cur = new Float64Array(m + 1);
  let best = 0, bestJ = null;
  for (let i = 1; i <= n; i++) {
    cur[0] = 0;
    const h = heard[i - 1];
    for (let j = 1; j <= m; j++) {
      const s = sim(h, script[lo + j - 1]);
      const match = s >= 0.8 ? 2 : s >= 0.6 ? 1 : -1;
      const diag = prev[j - 1] + match;
      const v = Math.max(0, diag, prev[j] - 1, cur[j - 1] - 0.7);
      cur[j] = v;
      // Only alignments where the newest heard word itself matches this script
      // word count; otherwise a stale match keeps scoring through a tangent.
      if (i === n && match > 0 && diag > best) { best = diag; bestJ = lo + j - 1; }
    }
    [prev, cur] = [cur, prev];
  }
  return { score: best, j: bestJ };
}

export class Tracker {
  static TAIL = 8;
  static BACK = 12;
  static AHEAD = 60;
  static MIN_SCORE = 3.5;   // about two matched words
  static JUMP_SCORE = 7.5;  // about four exact words, to relocate outside the window
  static MAX_STEP = 3;      // words forward per update before it counts as a jump
  static MAX_BACK = 2;      // words back before it counts as a jump

  constructor(words) {
    this.script = words;
    this.pos = 0;           // index of the next word to read
    this.offScript = false;
    this.pending = null;    // a proposed jump waiting for the next word to confirm it
  }

  update(heard) {
    const T = Tracker;
    const tail = heard.slice(-T.TAIL);
    const lo = Math.max(0, this.pos - T.BACK), hi = Math.min(this.script.length, this.pos + T.AHEAD);
    let { score, j } = align(tail, this.script, lo, hi);
    if (j !== null) score -= 0.03 * Math.abs(j + 1 - this.pos);
    if (j === null || score < T.MIN_SCORE) {
      const g = align(tail, this.script, 0, this.script.length);
      if (g.j !== null && g.score >= T.JUMP_SCORE) j = g.j;
      else { this.offScript = tail.length >= 3; return; }
    }
    this.offScript = false;
    // Small steps forward are normal reading. A bigger jump only happens once
    // the next word agrees with it: one misheard word ("they" for "the") can
    // make a spot further on score best for a moment.
    const step = j + 1 - this.pos;
    if (step > T.MAX_STEP || step < -T.MAX_BACK) {
      const agrees = this.pending !== null && Math.abs(j - this.pending) <= T.MAX_STEP + 1;
      this.pending = j;
      if (!agrees) return;
    }
    this.pending = null;
    this.pos = j + 1;
  }
}
