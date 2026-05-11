import { buildReceipt, printReceipt, downloadReceiptAsPNG } from './receipt.js';
import { state as audioState, ensureAudio, unlockAudio, setAudioEnabled,
         isAudioEnabled, stopAllAudio } from './audio.js';
import { scheduleCharAccent, scheduleHeadReverse, scheduleLineFeed } from './printer.js';
import { pushHash, readHash } from './url-state.js';

const $ = (id) => document.getElementById(id);
const text = $('text');
const receipt = $('receipt');
const soundCb = $('sound');
const colsInput = $('cols');
const printBtn = $('print');
const dlBtn = $('download');

const DEFAULT_TEXT = `.title VOID & CO.
.rule
RECEIPT\\t#4F8K
FILED\\t${nowLocal()}
.rule
1 x SCREAM\\t∅
.rule
.center **REVIEW: DULY NOTED**
.center the void *thanks you* for your contribution.
.center please scream again.
.small .center VR-4F8K-0421`;

function nowLocal() {
  const d = new Date();
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/* --- restore state from URL hash (if any) ------------------------ */

{
  const h = readHash();
  if (h.text !== undefined) text.value = h.text;
  else                      text.value = DEFAULT_TEXT;
  if (h.cols)               colsInput.value = String(parseInt(h.cols, 10) || 32);
  if (h.sound)              soundCb.checked = h.sound === '1';
}

function applyCols() {
  const n = Math.max(12, Math.min(200, Number(colsInput.value) || 32));
  receipt.style.setProperty('--cols', n);
}
applyCols();

/* --- live preview (build without animation) ---------------------- */

function previewNow() {
  /* skip-anim set BEFORE building so new lines render full-height
     with no transitions — keystroke rebuilds don't flash. */
  receipt.classList.add('skip-anim');
  buildReceipt(receipt, text.value);
  syncHash();
}
previewNow();

function syncHash() {
  pushHash({
    cols: Number(colsInput.value) || 32,
    sound: soundCb.checked,
    text: text.value
  });
}

let liveTimer = 0;
text.addEventListener('input', () => {
  clearTimeout(liveTimer);
  liveTimer = setTimeout(previewNow, 120);
});

colsInput.addEventListener('input', () => {
  applyCols();
  /* rebuild so .rule lines re-measure their dot count for the new width */
  previewNow();
});

soundCb.addEventListener('change', () => {
  if (soundCb.checked) ensureAudio();   /* lazy-init on first opt-in */
  setAudioEnabled(soundCb.checked);
  syncHash();
});

/* --- print (with animation + optional audio) --------------------- */

let printAbort = null;

async function runPrint() {
  if (printAbort) { printAbort.abort(); printAbort = null; }
  printAbort = new AbortController();

  receipt.classList.remove('skip-anim');
  buildReceipt(receipt, text.value);

  const useSound = soundCb.checked;
  if (useSound) {
    ensureAudio();
    setAudioEnabled(true);
  } else {
    setAudioEnabled(false);
  }

  await printReceipt(receipt, {
    signal: printAbort.signal,
    onPrintStart: ({ events, lineStarts, linePauseMs }) => {
      if (!isAudioEnabled()) return;
      scheduleAllAudio(events, lineStarts, linePauseMs);
    },
    /* onChar / onLineStart are NOT used for audio here — we schedule
       everything upfront in onPrintStart for tighter timing precision
       (rAF can drift; AudioContext.currentTime can't). */
    onPrintEnd: ({ aborted }) => {
      if (aborted) stopAllAudio();
    }
  }).catch(err => {
    if (err.name !== 'AbortError') console.error(err);
  });
}

/* Pre-schedule the entire print's audio relative to an anchor time
   t0 just slightly in the future. Engine + motor are ramped IN at
   t0, ducked + restored across each line pause, and ramped OUT at
   the very end. Per-char strikes, head-reverse thunks, and
   line-feed rollers are all scheduled inline. */
function scheduleAllAudio(events, lineStarts, linePauseMs) {
  const ctx = audioState.audioCtx;
  const engine = audioState.engine;
  const motor  = audioState.motor;
  if (!ctx || !engine || !motor) return;

  const t0 = ctx.currentTime + 0.04;
  const rect = receipt.getBoundingClientRect();

  /* Engine + motor IN */
  engine.env.gain.cancelScheduledValues(t0);
  engine.env.gain.setValueAtTime(0, t0);
  engine.env.gain.linearRampToValueAtTime(engine.baseLevel, t0 + 0.080);
  motor.gain.gain.cancelScheduledValues(t0);
  motor.gain.gain.setValueAtTime(0, t0);
  motor.gain.gain.linearRampToValueAtTime(motor.runLevel, t0 + 0.080);
  if (motor.lfoG) {
    motor.lfoG.gain.cancelScheduledValues(t0);
    motor.lfoG.gain.setValueAtTime(0, t0);
    motor.lfoG.gain.linearRampToValueAtTime(motor.lfoLevel, t0 + 0.080);
  }
  /* Initial paper feed sweep before the first character. */
  scheduleLineFeed(t0 - 0.020);

  /* Engine pan ramps per line — head sweeps L→R then R→L
     alternating. Skip rows with no content (lineLen=0): the ramp's
     start and end would coincide, and any non-finite math
     downstream trips setValueAtTime's finite-value check. */
  if (engine.pan) {
    for (const ls of lineStarts) {
      if (!ls.lineLen || !Number.isFinite(ls.t)) continue;
      const tStart = t0 + ls.t / 1000;
      const tEnd   = tStart + (ls.lineLen * ls.charMs) / 1000;
      if (!Number.isFinite(tStart) || !Number.isFinite(tEnd)) continue;
      engine.pan.pan.setValueAtTime(ls.ltr ? -0.85 : 0.85, tStart);
      engine.pan.pan.linearRampToValueAtTime(ls.ltr ? 0.85 : -0.85, tEnd);
    }
  }

  /* Per-line transition: head-reverse thunk + line-feed roller.
     Engine and motor keep running through travel AND through the
     paper feed pause — the head-reverse + roller sounds layer over
     the bed. The bed only ramps in/out at the start/end of the
     whole print, not per-line. */
  for (let li = 1; li < lineStarts.length; li++) {
    const prev = lineStarts[li - 1];
    const here = lineStarts[li];
    const panSide = prev.ltr ? 0.7 : -0.7;
    const tStart = t0 + here.t / 1000;
    const tPauseStart = tStart - linePauseMs / 1000;
    scheduleHeadReverse(tPauseStart + 0.020, panSide);
    scheduleLineFeed(tPauseStart + 0.060);
  }

  /* Per-character pin clusters. Pan from the char's x within the
     receipt; bold lines get double-strike emphasis. */
  for (const ev of events) {
    if (ev.kind !== 'char') continue;
    const ch = ev.span.textContent;
    if (!ch || !ch.trim()) continue;
    const cr = ev.span.getBoundingClientRect();
    const cx = cr.left + cr.width / 2;
    const norm = ((cx - rect.left) / Math.max(1, rect.width)) * 2 - 1;
    /* stepMs is the time the head spends traversing THIS char's cell —
     pass it as the traversal duration so scheduleCharAccent can
     spread its pin cluster across that span instead of bunching
     them into a 1.4 ms blip. */
    const traversalSec = (ev.stepMs || 7) / 1000;
    scheduleCharAccent(
      t0 + ev.t / 1000,
      ch,
      Math.max(-1, Math.min(1, norm * 0.85)),
      ev.linePos,
      ev.ltr,
      undefined,
      ev.bold,
      traversalSec
    );
  }

  /* Final line-feed + engine/motor ramp OUT after the last char. */
  const lastT = events.length ? events[events.length - 1].t : 0;
  const tEnd = t0 + lastT / 1000;
  scheduleLineFeed(tEnd + 0.060);
  engine.env.gain.setValueAtTime(engine.baseLevel, tEnd + 0.060);
  engine.env.gain.linearRampToValueAtTime(0, tEnd + 0.260);
  motor.gain.gain.setValueAtTime(motor.runLevel, tEnd + 0.060);
  motor.gain.gain.linearRampToValueAtTime(0, tEnd + 0.300);
  if (motor.lfoG) {
    motor.lfoG.gain.setValueAtTime(motor.lfoLevel, tEnd + 0.060);
    motor.lfoG.gain.linearRampToValueAtTime(0, tEnd + 0.300);
  }
}

printBtn.addEventListener('click', runPrint);

/* --- download ---------------------------------------------------- */

dlBtn.addEventListener('click', async () => {
  /* always download the fully-rendered version regardless of whether
     the print animation is in progress. */
  await downloadReceiptAsPNG(receipt, 'receipt.png');
});

