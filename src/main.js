import { buildReceipt, printReceipt, downloadReceiptAsPNG } from './receipt.js';
import { audio, unlockAudio, isAudioReady } from './audio.js';

const $ = (id) => document.getElementById(id);
const text = $('text');
const receipt = $('receipt');
const soundCb = $('sound');
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

text.value = DEFAULT_TEXT;

/* --- live preview (build without animation) ---------------------- */

function previewNow() {
  buildReceipt(receipt, text.value);
  receipt.classList.add('skip-anim');
  for (const ch of receipt.querySelectorAll('.ch')) ch.classList.add('printed');
  for (const line of receipt.querySelectorAll('.line')) line.classList.add('line-fed');
}
previewNow();

let liveTimer = 0;
text.addEventListener('input', () => {
  clearTimeout(liveTimer);
  liveTimer = setTimeout(previewNow, 120);
});

/* --- print (with animation + optional audio) --------------------- */

let printAbort = null;

async function runPrint() {
  if (printAbort) { printAbort.abort(); printAbort = null; }
  printAbort = new AbortController();

  buildReceipt(receipt, text.value);
  /* the print animation expects max-height: 0 lines that open as
     they're fed — skip-anim shows everything immediately, so remove
     it for the print run. */
  receipt.classList.remove('skip-anim');
  for (const ch of receipt.querySelectorAll('.ch')) ch.classList.remove('printed');
  for (const line of receipt.querySelectorAll('.line')) line.classList.remove('line-fed');

  const useSound = soundCb.checked;
  let audioSession = null;

  await printReceipt(receipt, {
    signal: printAbort.signal,
    onPrintStart: ({ totalMs }) => {
      if (!useSound) return;
      unlockAudio();
      audioSession = audio.beginPrint(0.04, totalMs);
    },
    onLineStart: ({ t }) => {
      if (!useSound || !audioSession) return;
      audio.lineStart(audioSession.t0, t);
    },
    onChar: ({ t, span, ltr, bold }) => {
      if (!useSound || !audioSession) return;
      /* Estimate pan from the char's x within the receipt for a
         left-right head sweep effect. Use line direction as fallback
         when bounding rect isn't yet measured. */
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
      if (!useSound || !audioSession || aborted) return;
      /* total duration = last char time + small tail */
      const lastChar = receipt.querySelector('.ch.printed:last-of-type');
      audio.endPrint(audioSession.t0, /* totalSec */ performance.now() / 1000);
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

/* --- sound toggle unlocks AudioContext on user gesture so we can
   schedule audio later without browser blocking it. ----------------- */

soundCb.addEventListener('change', () => {
  if (soundCb.checked) unlockAudio();
});
