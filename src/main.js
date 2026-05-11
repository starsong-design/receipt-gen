import { buildReceipt, printReceipt, downloadReceiptAsPNG } from './receipt.js';
import { audio, unlockAudio, isAudioReady } from './audio.js';
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
.row RECEIPT  #4F8K
.row FILED    ${nowLocal()}
.rule
.row 1 x SCREAM  ∅
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
  const n = Math.max(12, Math.min(80, Number(colsInput.value) || 32));
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
  if (soundCb.checked) unlockAudio();
  syncHash();
});

/* --- print (with animation + optional audio) --------------------- */

let printAbort = null;

async function runPrint() {
  if (printAbort) { printAbort.abort(); printAbort = null; }
  printAbort = new AbortController();

  /* the print animation expects max-height: 0 lines that open as
     they're fed — remove skip-anim first so the lines start collapsed,
     then build. */
  receipt.classList.remove('skip-anim');
  buildReceipt(receipt, text.value);

  const useSound = soundCb.checked;
  let audioSession = null;

  await printReceipt(receipt, {
    signal: printAbort.signal,
    onPrintStart: () => {
      if (!useSound) return;
      unlockAudio();
      audioSession = audio.beginPrint();
    },
    onLineStart: ({ t }) => {
      if (!useSound || !audioSession) return;
      audio.lineStart(audioSession.t0, t);
    },
    onChar: ({ t, span, ltr, bold }) => {
      if (!useSound || !audioSession) return;
      /* Pan from the char's x within the receipt (head sweep). */
      const rect = receipt.getBoundingClientRect();
      const cr = span.getBoundingClientRect();
      const cx = cr.left + cr.width / 2;
      const norm = ((cx - rect.left) / Math.max(1, rect.width)) * 2 - 1;
      const pan = Number.isFinite(norm)
        ? Math.max(-1, Math.min(1, norm * 0.85))
        : (ltr ? -0.5 : 0.5);
      audio.char(audioSession.t0, t, pan, bold);
    },
    onPrintEnd: ({ aborted }) => {
      if (!useSound) return;
      if (aborted) audio.stopAll();
      else         audio.endPrint();
    }
  }).catch(err => {
    if (err.name !== 'AbortError') console.error(err);
  });
}

printBtn.addEventListener('click', runPrint);

/* --- download ---------------------------------------------------- */

dlBtn.addEventListener('click', async () => {
  /* always download the fully-rendered version regardless of whether
     the print animation is in progress. */
  await downloadReceiptAsPNG(receipt, 'receipt.png');
});

