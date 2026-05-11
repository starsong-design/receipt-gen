/* DMP printer synthesis: motor, engine, per-char pin strikes,
   head-reverse, line-feed roller. Ported from void-land. All events
   are pre-scheduled at audioCtx-precise times via gain ramps. */

import { state, isAudioEnabled } from './audio.js';

export function charFillScore(ch) {
  if (!ch || ch === ' ') return 0.20;
  if ('.,\'`~^'.includes(ch))                 return 0.18;
  if (':;-_·∅·'.includes(ch))                  return 0.28;
  if ("()[]{}<>/\\|!l1iI".includes(ch))       return 0.32;
  if ('?*+="'.includes(ch))                    return 0.45;
  if ('aeiouy0234567'.includes(ch))            return 0.55;
  if ('bcdfghjkmnpqrstuvwxz89'.includes(ch))   return 0.62;
  if ('ABCDEFGHIJKLMNOPQRSTUVWXYZ'.includes(ch)) return 0.78;
  if ('@#$%&'.includes(ch))                    return 0.92;
  return 0.55;
}

/* Persistent motor — created ONCE at audio init, runs forever with
   gain at 0. Each print schedules a gain ramp to make it audible. */
export function createPrinterMotor(out) {
  const ctx = state.audioCtx;
  if (!ctx) return null;
  const t0 = ctx.currentTime;
  const o1 = ctx.createOscillator(); o1.type = 'sawtooth'; o1.frequency.value = 145;
  const o2 = ctx.createOscillator(); o2.type = 'sawtooth'; o2.frequency.value = 217;
  o2.detune.value = +9;
  const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 720; lp.Q.value = 0.8;
  const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 80;
  const g  = ctx.createGain(); g.gain.value = 0;
  o1.connect(lp); o2.connect(lp); lp.connect(hp).connect(g).connect(out);
  /* 6.3 Hz wobble on the motor's gain. Gated off at rest so the
     wobble isn't audible during silence. */
  const lfo  = ctx.createOscillator(); lfo.type = 'sine'; lfo.frequency.value = 6.3;
  const lfoG = ctx.createGain(); lfoG.gain.value = 0;
  lfo.connect(lfoG).connect(g.gain);
  o1.start(t0); o2.start(t0); lfo.start(t0);
  return { gain: g, lfoG, runLevel: 0.06, lfoLevel: 0.012 };
}

/* Persistent DMP engine — gated by env.gain. The print loop ramps
   env up at start, ducks it during line pauses, ramps it out at end. */
export function createDMPEngine(out) {
  const ctx = state.audioCtx;
  if (!ctx) return null;
  const t0 = ctx.currentTime;
  const sr = ctx.sampleRate;

  const saw = ctx.createOscillator();
  saw.type = 'sawtooth';
  saw.frequency.value = 1370;

  const nbuf = ctx.createBuffer(1, sr * 2, sr);
  const ndata = nbuf.getChannelData(0);
  for (let i = 0; i < ndata.length; i++) ndata[i] = Math.random() * 2 - 1;
  const noise = ctx.createBufferSource();
  noise.buffer = nbuf;
  noise.loop = true;

  const sawG   = ctx.createGain(); sawG.gain.value = 0.55;
  const noiseG = ctx.createGain(); noiseG.gain.value = 0.35;
  saw.connect(sawG); noise.connect(noiseG);

  const mixA = ctx.createGain(); mixA.gain.value = 1.0;
  sawG.connect(mixA); noiseG.connect(mixA);

  const peak = ctx.createBiquadFilter();
  peak.type = 'peaking'; peak.frequency.value = 4125; peak.Q.value = 8; peak.gain.value = 16;
  const bp = ctx.createBiquadFilter();
  bp.type = 'bandpass'; bp.frequency.value = 4500; bp.Q.value = 1.2;

  /* AM modulation with slow frequency drift — gives the engine its
     characteristic warble. */
  const am = ctx.createGain(); am.gain.value = 0.0;
  const amOsc = ctx.createOscillator();
  amOsc.type = 'square'; amOsc.frequency.value = 34;
  const amDepth = ctx.createGain(); amDepth.gain.value = 0.55;
  amOsc.connect(amDepth).connect(am.gain);
  const amDriftLfo = ctx.createOscillator();
  amDriftLfo.type = 'sine'; amDriftLfo.frequency.value = 0.45;
  const amDriftG = ctx.createGain(); amDriftG.gain.value = 14;
  amDriftLfo.connect(amDriftG).connect(amOsc.frequency);

  mixA.connect(peak).connect(bp).connect(am);

  const ls = ctx.createBiquadFilter();
  ls.type = 'lowshelf'; ls.frequency.value = 280; ls.gain.value = 6;
  am.connect(ls);

  const pan = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
  if (pan) ls.connect(pan);

  const env = ctx.createGain();
  env.gain.value = 0;
  if (pan) pan.connect(env); else ls.connect(env);
  env.connect(out);

  saw.start(t0); noise.start(t0); amOsc.start(t0); amDriftLfo.start(t0);

  return { pan, env, baseLevel: 0.0085 };
}

/* Per-character pin cluster: 2-5 individual strikes within 0.8 ms,
   each with pitch/pan jitter so the cluster reads as a chord of
   needles rather than one tone. Bold = double-strike pass. */
export function scheduleCharAccent(when, ch, panNorm, linePos, ltr, destination, bold, traversalSec = 0.007) {
  const ctx = state.audioCtx;
  if (!ctx || !isAudioEnabled() || !ch || !ch.trim()) return;
  /* Rule dots get a single light tick. */
  if (ch === '·') {
    schedulePinTick(when, panNorm, destination);
    return;
  }
  /* Strikes spread across the head's traversal time over the
     character's cell — like a real DMP firing one pin column per
     dot column as the head sweeps across the letter. Fill factor
     determines the strike count (sparser chars like '.' get fewer,
     denser '@' gets more); bold doubles to simulate the double-pass
     emphasis stroke. */
  const fill = charFillScore(ch);
  let strikes = 2 + Math.round(fill * 4);   /* 2..6 strikes */
  if (bold) strikes *= 2;
  const slot = traversalSec / strikes;
  for (let s = 0; s < strikes; s++) {
    /* Each strike at the start of its slot + a small jitter within
       the slot for organic timing. */
    const tickWhen = when + (s + Math.random() * 0.6) * slot;
    schedulePinStrike(
      tickWhen,
      panNorm + (Math.random() - 0.5) * 0.08,
      fill,
      linePos ?? 0.5,
      ltr ?? true,
      destination
    );
  }
}

/* Quick percussive tick — short envelope, no high-Q resonant chain.
   Used for rule dots so they sound like a tape-typewriter ratchet
   rather than the heavy pin-cluster strikes used for text. */
function schedulePinTick(when, panNorm, destination) {
  const ctx = state.audioCtx;
  const out = destination || state.printerBus;
  const sr = ctx.sampleRate;
  const dur = 0.022;
  const len = Math.floor(dur * sr);
  const buf = ctx.createBuffer(1, len, sr);
  const data = buf.getChannelData(0);
  const atk = 4;
  const tail = sr * 0.007;
  const fadeStart = Math.floor(len * 0.82);
  for (let i = 0; i < len; i++) {
    let env = i < atk ? (i / atk) : Math.exp(-(i - atk) / tail);
    if (i >= fadeStart) env *= (len - 1 - i) / (len - 1 - fadeStart);
    data[i] = (Math.random() * 2 - 1) * env;
  }
  const src = ctx.createBufferSource(); src.buffer = buf;
  const hp = ctx.createBiquadFilter();
  hp.type = 'highpass'; hp.frequency.value = 1200; hp.Q.value = 0.4;
  const peak = ctx.createBiquadFilter();
  peak.type = 'peaking'; peak.frequency.value = 3800; peak.Q.value = 1.5; peak.gain.value = 6;
  const g = ctx.createGain(); g.gain.value = 0.035;
  const pan = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
  if (pan) pan.pan.value = Math.max(-1, Math.min(1, panNorm));
  src.connect(hp).connect(peak).connect(g);
  if (pan) g.connect(pan).connect(out); else g.connect(out);
  src.onended = () => {
    setTimeout(() => {
      try { g.disconnect(); if (pan) pan.disconnect(); } catch {}
    }, 30);
  };
  src.start(when);
}

/* Single pin striking the paper. Filter chain mimics real DMP analysis:
   fundamental 1.4 kHz, secondary 2.5 kHz, dominant 5.8-7.5 kHz, upper
   ting at 9.5-11 kHz, hard low-pass at 14 kHz. */
function schedulePinStrike(when, panNorm, fill, linePos, ltr, destination) {
  const ctx = state.audioCtx;
  const out = destination || state.printerBus;
  const sr = ctx.sampleRate;
  const dur = 0.065;
  const len = Math.floor(dur * sr);
  const buf = ctx.createBuffer(1, len, sr);
  const data = buf.getChannelData(0);
  const atk = 8;
  const tail = sr * 0.022;
  /* Explicit zero-fade-out over the last 12% guarantees data[len-1] = 0.
     Without it, the exp decay leaves a non-zero residual and source-end
     produces a click that accumulates audibly over thousands of strikes. */
  const fadeStart = Math.floor(len * 0.88);
  const fadeLen   = len - fadeStart;
  for (let i = 0; i < len; i++) {
    let env = i < atk ? (i / atk) : Math.exp(-(i - atk) / tail);
    if (i >= fadeStart) env *= (len - 1 - i) / (fadeLen - 1);
    data[i] = (Math.random() * 2 - 1) * env;
  }
  const src = ctx.createBufferSource(); src.buffer = buf;
  const hp = ctx.createBiquadFilter();
  hp.type = 'highpass'; hp.frequency.value = 700; hp.Q.value = 0.4;
  const fundFreq = 1700 + Math.random() * 280;
  const fund = ctx.createBiquadFilter();
  fund.type = 'peaking'; fund.frequency.value = fundFreq; fund.Q.value = 2.5; fund.gain.value = 6;
  const harm = ctx.createBiquadFilter();
  harm.type = 'peaking'; harm.frequency.value = fundFreq * 2; harm.Q.value = 3.5; harm.gain.value = 5;
  const sec = ctx.createBiquadFilter();
  sec.type = 'peaking'; sec.frequency.value = 2700 + Math.random() * 280; sec.Q.value = 2.0; sec.gain.value = 4;
  const screech = ctx.createBiquadFilter();
  screech.type = 'peaking'; screech.frequency.value = 6800 + Math.random() * 1700; screech.Q.value = 1.3; screech.gain.value = 10;
  const high = ctx.createBiquadFilter();
  high.type = 'peaking'; high.frequency.value = 11000 + Math.random() * 1700; high.Q.value = 1.5; high.gain.value = 6;
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass'; lp.frequency.value = 14500; lp.Q.value = 0.6;
  const g = ctx.createGain();
  g.gain.value = 0.022 + fill * 0.018;
  const pan = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
  if (pan) pan.pan.value = Math.max(-1, Math.min(1, panNorm));
  src.connect(hp).connect(fund).connect(harm).connect(sec).connect(screech).connect(high).connect(lp).connect(g);
  if (pan) g.connect(pan).connect(out); else g.connect(out);
  /* GC the chain after the source ends — without this, every print
     accumulates orphaned filters on the bus. Delay the disconnect so
     high-Q filter tails decay into silence before we cut them off. */
  src.onended = () => {
    setTimeout(() => {
      try { g.disconnect(); if (pan) pan.disconnect(); } catch {}
    }, 60);
  };
  src.start(when);
}

/* Head-reverse thunk at line transitions — mid-band noise + low
   thump, panned to the side the head was at. */
export function scheduleHeadReverse(when, panAt, destination) {
  const ctx = state.audioCtx;
  if (!ctx || !isAudioEnabled()) return;
  const out = destination || state.printerBus;
  const sr = ctx.sampleRate;
  const dur = 0.085;
  const len = Math.floor(dur * sr);
  const buf = ctx.createBuffer(1, len, sr);
  const data = buf.getChannelData(0);
  const fadeStart = Math.floor(len * 0.90);
  for (let i = 0; i < len; i++) {
    const t = i / len;
    let env = (t < 0.04 ? t / 0.04 : Math.exp(-(t - 0.04) * 6));
    if (i >= fadeStart) env *= (len - 1 - i) / (len - 1 - fadeStart);
    data[i] = (Math.random() * 2 - 1) * env;
  }
  const src = ctx.createBufferSource(); src.buffer = buf;
  const bp = ctx.createBiquadFilter();
  bp.type = 'bandpass'; bp.frequency.value = 850; bp.Q.value = 1.4;
  const thumpSrc = ctx.createBufferSource(); thumpSrc.buffer = buf;
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass'; lp.frequency.value = 280; lp.Q.value = 0.9;
  const gMid = ctx.createGain(); gMid.gain.value = 0.10;
  const gLo  = ctx.createGain(); gLo.gain.value  = 0.18;
  const pan = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
  if (pan) pan.pan.value = Math.max(-1, Math.min(1, panAt));
  src.connect(bp).connect(gMid);
  thumpSrc.connect(lp).connect(gLo);
  if (pan) {
    gMid.connect(pan); gLo.connect(pan); pan.connect(out);
  } else {
    gMid.connect(out); gLo.connect(out);
  }
  src.start(when); thumpSrc.start(when);
  src.onended = () => {
    setTimeout(() => {
      try { gMid.disconnect(); gLo.disconnect(); if (pan) pan.disconnect(); } catch {}
    }, 60);
  };
}

/* Line-feed roller — three stages, ~310 ms total: engage thunk →
   whirr (sawtooth motor + paper-friction noise sweep) → lock thunk. */
export function scheduleLineFeed(when, destination) {
  const ctx = state.audioCtx;
  if (!ctx || !isAudioEnabled()) return;
  const out = destination || state.printerBus;
  const sr = ctx.sampleRate;

  /* (1) ENGAGE — low thunk with body, not tinny */
  {
    const tDur = 0.060;
    const tLen = Math.floor(tDur * sr);
    const tBuf = ctx.createBuffer(1, tLen, sr);
    const td = tBuf.getChannelData(0);
    const atk = 6;
    const tail = sr * 0.012;
    const tFadeStart = Math.floor(tLen * 0.88);
    for (let i = 0; i < tLen; i++) {
      let env = i < atk ? (i / atk) : Math.exp(-(i - atk) / tail);
      if (i >= tFadeStart) env *= (tLen - 1 - i) / (tLen - 1 - tFadeStart);
      td[i] = (Math.random() * 2 - 1) * env;
    }
    const src = ctx.createBufferSource(); src.buffer = tBuf;
    const peak = ctx.createBiquadFilter();
    peak.type = 'peaking'; peak.frequency.value = 380; peak.Q.value = 2.2; peak.gain.value = 9;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = 850; lp.Q.value = 0.7;
    const g = ctx.createGain(); g.gain.value = 0.20;
    src.connect(peak).connect(lp).connect(g).connect(out);
    src.start(when);

    const tSrc = ctx.createBufferSource(); tSrc.buffer = tBuf;
    const subLp = ctx.createBiquadFilter();
    subLp.type = 'lowpass'; subLp.frequency.value = 130; subLp.Q.value = 1.0;
    const gLo = ctx.createGain(); gLo.gain.value = 0.21;
    tSrc.connect(subLp).connect(gLo).connect(out);
    tSrc.start(when);
  }

  /* (2) WHIRR — sawtooth motor (frequency arc) + paper-friction noise */
  const whirrStart = when + 0.022;
  const whirrDur = 0.260;
  const whirrLen = Math.floor(whirrDur * sr);

  /* trapezoidal envelope: accel → cruise → decel. */
  const accelEnd = 0.15;
  const decelStart = 0.72;
  function envAt(u) {
    if (u < accelEnd) {
      const v = u / accelEnd;
      return v * v * (3 - 2 * v);
    }
    if (u < decelStart) return 1;
    const v = (u - decelStart) / (1 - decelStart);
    return 1 - v * v * (3 - 2 * v);
  }

  /* motor sawtooth — fundamental ~70 Hz with arc */
  const motorBuf = ctx.createBuffer(1, whirrLen, sr);
  const motorData = motorBuf.getChannelData(0);
  let phase = 0;
  for (let i = 0; i < whirrLen; i++) {
    const u = i / whirrLen;
    let f;
    if (u < accelEnd)        f = 55 + (95 - 55) * (u / accelEnd);
    else if (u < decelStart) f = 95;
    else                     f = 95 - (95 - 50) * ((u - decelStart) / (1 - decelStart));
    phase += f / sr;
    const saw = (phase % 1) * 2 - 1;
    motorData[i] = saw * envAt(u);
  }
  const motorSrc = ctx.createBufferSource(); motorSrc.buffer = motorBuf;
  const motorLp = ctx.createBiquadFilter();
  motorLp.type = 'lowpass'; motorLp.frequency.value = 420; motorLp.Q.value = 0.9;
  const motorPeak = ctx.createBiquadFilter();
  motorPeak.type = 'peaking'; motorPeak.frequency.value = 95; motorPeak.Q.value = 1.5; motorPeak.gain.value = 8;
  const motorG = ctx.createGain(); motorG.gain.value = 0.13;
  motorSrc.connect(motorPeak).connect(motorLp).connect(motorG).connect(out);
  motorSrc.start(whirrStart);

  /* paper-friction with pitch-down bandpass sweep */
  const fricBuf = ctx.createBuffer(1, whirrLen, sr);
  const fricData = fricBuf.getChannelData(0);
  for (let i = 0; i < whirrLen; i++) {
    const u = i / whirrLen;
    fricData[i] = (Math.random() * 2 - 1) * envAt(u);
  }
  const fricSrc = ctx.createBufferSource(); fricSrc.buffer = fricBuf;
  const fricBp = ctx.createBiquadFilter();
  fricBp.type = 'bandpass'; fricBp.Q.value = 0.95;
  fricBp.frequency.setValueAtTime(310, whirrStart);
  fricBp.frequency.linearRampToValueAtTime(170, whirrStart + whirrDur);
  const fricLp = ctx.createBiquadFilter();
  fricLp.type = 'lowpass'; fricLp.frequency.value = 1100; fricLp.Q.value = 0.5;
  const fricG = ctx.createGain(); fricG.gain.value = 0.09;
  fricSrc.connect(fricBp).connect(fricLp).connect(fricG).connect(out);
  fricSrc.start(whirrStart);

  /* (3) LOCK — gear teeth re-engaging at the end */
  const lockAt = whirrStart + whirrDur - 0.020;
  {
    const tDur = 0.050;
    const tLen = Math.floor(tDur * sr);
    const tBuf = ctx.createBuffer(1, tLen, sr);
    const td = tBuf.getChannelData(0);
    const atk = 5;
    const tail = sr * 0.009;
    const tFadeStart = Math.floor(tLen * 0.86);
    for (let i = 0; i < tLen; i++) {
      let env = i < atk ? (i / atk) : Math.exp(-(i - atk) / tail);
      if (i >= tFadeStart) env *= (tLen - 1 - i) / (tLen - 1 - tFadeStart);
      td[i] = (Math.random() * 2 - 1) * env;
    }
    const src = ctx.createBufferSource(); src.buffer = tBuf;
    const peak = ctx.createBiquadFilter();
    peak.type = 'peaking'; peak.frequency.value = 320; peak.Q.value = 2.0; peak.gain.value = 7;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = 700; lp.Q.value = 0.7;
    const g = ctx.createGain(); g.gain.value = 0.13;
    src.connect(peak).connect(lp).connect(g).connect(out);
    src.start(lockAt);

    const tSrc = ctx.createBufferSource(); tSrc.buffer = tBuf;
    const subLp = ctx.createBiquadFilter();
    subLp.type = 'lowpass'; subLp.frequency.value = 110; subLp.Q.value = 1.0;
    const gLo = ctx.createGain(); gLo.gain.value = 0.14;
    tSrc.connect(subLp).connect(gLo).connect(out);
    tSrc.start(lockAt);
  }
}
