/* Printer sound: short ticks per character + paper-feed sweep per
   line + low engine bed during print.

   All scheduling is anchored to the AudioContext's own clock
   (ctx.currentTime). Callers pass `msFromT0` for per-char timing
   relative to a print-start `t0` returned by beginPrint(); start /
   stop of the engine bed are absolute (use ctx.currentTime). */

let ctx = null;
let masterGain = null;
let engine = null;          /* persistent low oscillator */

function ensureCtx() {
  if (ctx) return ctx;
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return null;
  ctx = new AC();
  masterGain = ctx.createGain();
  masterGain.gain.value = 0.55;
  const limiter = ctx.createDynamicsCompressor();
  limiter.threshold.value = -3;
  limiter.knee.value = 6;
  limiter.ratio.value = 2;
  limiter.attack.value = 0.010;
  limiter.release.value = 0.250;
  masterGain.connect(limiter).connect(ctx.destination);
  return ctx;
}

function startEngine() {
  if (!ctx || engine) return;
  const osc = ctx.createOscillator();
  osc.type = 'sawtooth';
  osc.frequency.value = 110;
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = 320;
  lp.Q.value = 2;
  const g = ctx.createGain();
  g.gain.value = 0;
  osc.connect(lp).connect(g).connect(masterGain);
  osc.start();
  engine = { g };
}

/* Ramp engine gain from its current scheduled value to `level` over
   `dur` seconds, starting at `at`. cancelScheduledValues clears any
   pending ramps so the new one always takes precedence. */
function rampEngine(level, at, dur = 0.08) {
  if (!engine) return;
  const t = Math.max(at, ctx.currentTime);
  engine.g.gain.cancelScheduledValues(t);
  engine.g.gain.setValueAtTime(engine.g.gain.value, t);
  engine.g.gain.linearRampToValueAtTime(level, t + dur);
}

function tick(time, pan = 0, bold = false) {
  if (!ctx) return;
  const dur = bold ? 0.022 : 0.014;
  const buf = ctx.createBuffer(1, Math.ceil(dur * ctx.sampleRate), ctx.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < data.length; i++) {
    const t = i / data.length;
    data[i] = (Math.random() * 2 - 1) * Math.exp(-t * 12);
  }
  const src = ctx.createBufferSource();
  src.buffer = buf;
  const bp = ctx.createBiquadFilter();
  bp.type = 'bandpass';
  bp.frequency.value = bold ? 1500 : 2200;
  bp.Q.value = bold ? 6 : 4;
  const g = ctx.createGain();
  g.gain.value = bold ? 0.16 : 0.10;
  const pn = ctx.createStereoPanner();
  pn.pan.value = Math.max(-1, Math.min(1, pan));
  src.connect(bp).connect(g).connect(pn).connect(masterGain);
  src.start(time);
}

function feed(time) {
  if (!ctx) return;
  const dur = 0.12;
  const buf = ctx.createBuffer(1, Math.ceil(dur * ctx.sampleRate), ctx.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < data.length; i++) {
    const t = i / data.length;
    data[i] = (Math.random() * 2 - 1) * Math.sin(t * Math.PI);
  }
  const src = ctx.createBufferSource();
  src.buffer = buf;
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = 700;
  lp.Q.value = 1;
  const g = ctx.createGain();
  g.gain.value = 0.045;
  src.connect(lp).connect(g).connect(masterGain);
  src.start(time);
}

export function unlockAudio() {
  ensureCtx();
  if (ctx && ctx.state === 'suspended') ctx.resume();
}

export const audio = {
  /* Called at the start of a print. Starts the engine bed (ramps up
     from 0) and returns the `t0` reference time. char() and
     lineStart() are scheduled relative to t0; endPrint() ramps the
     engine back down and is anchored to the moment it's called. */
  beginPrint() {
    ensureCtx();
    if (!ctx) return null;
    if (ctx.state === 'suspended') ctx.resume();
    startEngine();
    const t0 = ctx.currentTime + 0.04;
    feed(t0);
    rampEngine(0.06, t0, 0.080);
    return { t0 };
  },
  char(t0, msFromT0, pan, bold) {
    if (!ctx) return;
    tick(t0 + msFromT0 / 1000, pan, bold);
  },
  lineStart(t0, msFromT0) {
    if (!ctx) return;
    feed(t0 + msFromT0 / 1000);
  },
  /* Called when the per-char loop is finished. Ramps the engine
     down to silence over 250 ms from now. No t0 / duration tracking
     needed — we're always anchored to ctx.currentTime. */
  endPrint() {
    if (!ctx) return;
    const now = ctx.currentTime;
    feed(now + 0.02);
    rampEngine(0, now + 0.05, 0.25);
  },
  /* Hard stop: cancels pending ramps and silences the engine
     immediately. Use on print-abort. */
  stopAll() {
    if (!ctx || !engine) return;
    const now = ctx.currentTime;
    engine.g.gain.cancelScheduledValues(now);
    engine.g.gain.setValueAtTime(0, now);
  }
};
