/* Lightweight printer sound — short ticks per character + a paper
   feed sweep per line. Intentionally not as fancy as void-land's
   per-glyph weighting; just enough to feel mechanical.

   AudioContext is created lazily on first user gesture, since
   browsers block silent contexts pre-interaction. */

let ctx = null;
let masterGain = null;
let limiter = null;

function ensureCtx() {
  if (ctx) return ctx;
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return null;
  ctx = new AC();
  masterGain = ctx.createGain();
  masterGain.gain.value = 0.55;
  limiter = ctx.createDynamicsCompressor();
  limiter.threshold.value = -3;
  limiter.knee.value = 6;
  limiter.ratio.value = 2;
  limiter.attack.value = 0.010;
  limiter.release.value = 0.250;
  masterGain.connect(limiter).connect(ctx.destination);
  return ctx;
}

/* a tiny pop — bandpass-filtered noise burst */
function tick(time, pan = 0, gain = 1, bold = false) {
  if (!ctx) return;
  const dur = bold ? 0.022 : 0.014;
  const buf = ctx.createBuffer(1, Math.ceil(dur * ctx.sampleRate), ctx.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < data.length; i++) {
    const t = i / data.length;
    /* exponential decay envelope */
    data[i] = (Math.random() * 2 - 1) * Math.exp(-t * 12);
  }
  const src = ctx.createBufferSource();
  src.buffer = buf;
  const bp = ctx.createBiquadFilter();
  bp.type = 'bandpass';
  bp.frequency.value = bold ? 1500 : 2200;
  bp.Q.value = bold ? 6 : 4;
  const g = ctx.createGain();
  g.gain.value = (bold ? 0.16 : 0.10) * gain;
  const pn = ctx.createStereoPanner();
  pn.pan.value = Math.max(-1, Math.min(1, pan));
  src.connect(bp).connect(g).connect(pn).connect(masterGain);
  src.start(time);
}

/* paper feed — a low whoosh */
function feed(time) {
  if (!ctx) return;
  const dur = 0.12;
  const buf = ctx.createBuffer(1, Math.ceil(dur * ctx.sampleRate), ctx.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < data.length; i++) {
    const t = i / data.length;
    /* attack→decay shape */
    const env = Math.sin(t * Math.PI);
    data[i] = (Math.random() * 2 - 1) * env;
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

/* engine — a constant low hum during print, used as a bed */
let engine = null;
function startEngine() {
  if (!ctx) return;
  if (engine) return engine;
  const osc = ctx.createOscillator();
  osc.type = 'sawtooth';
  osc.frequency.value = 110;
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = 320;
  lp.Q.value = 2;
  const g = ctx.createGain();
  g.gain.value = 0.0;
  osc.connect(lp).connect(g).connect(masterGain);
  osc.start();
  engine = { osc, g };
  return engine;
}
function rampEngine(level, time, dur = 0.08) {
  if (!engine) return;
  engine.g.gain.cancelScheduledValues(time);
  engine.g.gain.setValueAtTime(engine.g.gain.value, time);
  engine.g.gain.linearRampToValueAtTime(level, time + dur);
}

export function isAudioReady() { return !!ctx; }

export function unlockAudio() {
  ensureCtx();
  if (ctx && ctx.state === 'suspended') ctx.resume();
}

export const audio = {
  /* called when a print starts; schedules a paper feed and engine
     ramp-in at t0. */
  beginPrint(t0Offset = 0.04, totalMs = 0) {
    ensureCtx();
    if (!ctx) return null;
    if (ctx.state === 'suspended') ctx.resume();
    startEngine();
    const t0 = ctx.currentTime + t0Offset;
    feed(t0);
    rampEngine(0.06, t0);
    return { t0, ctx };
  },
  endPrint(t0, totalSec) {
    if (!ctx || !engine) return;
    feed(t0 + totalSec + 0.06);
    rampEngine(0.0, t0 + totalSec + 0.10, 0.25);
  },
  char(t0, msFromT0, pan, bold) {
    if (!ctx) return;
    tick(t0 + msFromT0 / 1000, pan, 1, bold);
  },
  lineStart(t0, msFromT0) {
    if (!ctx) return;
    feed(t0 + msFromT0 / 1000);
  }
};
