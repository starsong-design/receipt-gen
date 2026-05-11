/* Audio context + master bus + soft-clipped printer bus + persistent
   DMP engine/motor. Ported from void-land. The printer.js module
   schedules pin strikes, head-reverse thunks, and line-feed rollers
   onto this bus.

   Engine/motor are constructed ONCE at init and run silently forever
   (gain at 0). Each print just schedules gain ramps — no node
   creation per-print means no startup clicks. */

import { createDMPEngine, createPrinterMotor } from './printer.js';

export const state = {
  audioCtx: null,
  masterGain: null,
  printerBus: null,
  engine: null,
  motor: null,
  audioStarted: false,
  enabled: false
};

function initAudio() {
  if (state.audioCtx) return;
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  state.audioCtx = ctx;

  state.masterGain = ctx.createGain();
  state.masterGain.gain.value = 0.0;        /* ramped up by startRamps */

  /* Master safety limiter — catches summed peaks at the end. */
  const masterLimiter = ctx.createDynamicsCompressor();
  masterLimiter.threshold.value = -3;
  masterLimiter.knee.value = 6;
  masterLimiter.ratio.value = 2;
  masterLimiter.attack.value = 0.010;
  masterLimiter.release.value = 0.40;
  state.masterGain.connect(masterLimiter).connect(ctx.destination);

  /* Printer bus with a tanh soft-clip BEFORE the master limiter.
     WaveShaper has no internal envelope state so it can't pop when
     signal first arrives — and it doesn't duck other channels. */
  state.printerBus = ctx.createGain();
  state.printerBus.gain.value = 0.55;
  const softClip = ctx.createWaveShaper();
  const N = 2048;
  const curve = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const x = (i - N / 2) / (N / 2) * 2;       /* input range -2..+2 */
    curve[i] = Math.tanh(x);                    /* asymptote at ±1 */
  }
  softClip.curve = curve;
  softClip.oversample = '4x';
  state.printerBus.connect(softClip).connect(state.masterGain);

  /* Persistent engine + motor — silent at rest. */
  state.engine = createDMPEngine(state.printerBus);
  state.motor  = createPrinterMotor(state.printerBus);
}

function startRamps() {
  const ctx = state.audioCtx;
  if (!ctx) return;
  const t = ctx.currentTime;
  const muteHold = 0.3;
  state.masterGain.gain.cancelScheduledValues(t);
  state.masterGain.gain.setValueAtTime(0, t);
  state.masterGain.gain.setValueAtTime(0, t + muteHold);
  state.masterGain.gain.linearRampToValueAtTime(1.0, t + muteHold + 0.08);
}

/* Called on every user gesture that might want to enable audio.
   Initialises the context lazily and resumes if suspended. */
export function ensureAudio() {
  if (!state.audioCtx) initAudio();
  const ctx = state.audioCtx;
  if (!ctx) return;
  if (ctx.state === 'suspended') {
    ctx.resume().then(() => {
      if (!state.audioStarted) { state.audioStarted = true; startRamps(); }
    });
  } else if (!state.audioStarted) {
    state.audioStarted = true;
    startRamps();
  }
}

/* Alias kept for symmetry with the previous API. */
export const unlockAudio = ensureAudio;

/* The sound toggle in main.js gates whether scheduleX functions
   actually fire. Mimics void-land's `humOn` flag. */
export function setAudioEnabled(on) { state.enabled = on; }
export function isAudioEnabled() { return state.enabled; }

/* Hard stop — used on print abort. Cancels all pending engine/motor
   ramps and silences them immediately. Already-scheduled char strikes
   on the printer bus will still fire (Web Audio doesn't let us
   unschedule individual node.start() calls), but the bed shuts up. */
export function stopAllAudio() {
  if (!state.audioCtx) return;
  const ctx = state.audioCtx;
  const now = ctx.currentTime;
  const engine = state.engine;
  const motor  = state.motor;
  if (engine && engine.env) {
    engine.env.gain.cancelScheduledValues(now);
    engine.env.gain.setValueAtTime(0, now);
  }
  if (motor && motor.gain) {
    motor.gain.gain.cancelScheduledValues(now);
    motor.gain.gain.setValueAtTime(0, now);
    if (motor.lfoG) {
      motor.lfoG.gain.cancelScheduledValues(now);
      motor.lfoG.gain.setValueAtTime(0, now);
    }
  }
}
