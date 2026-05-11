/* Receipt builder + per-char print animation + PNG export (via SVG
   foreignObject, same trick as void-land). */

import { parseReceipt } from './markdown.js';

export function buildReceipt(target, text) {
  const lines = parseReceipt(text);
  /* Build line elements with per-char spans for the print animation.
     The caller controls .skip-anim — buildReceipt itself doesn't
     touch it, so live-preview rebuilds don't flash through the
     animated state. */
  target.innerHTML = '';
  for (const line of lines) {
    const el = document.createElement('div');
    el.className = line.classes.join(' ');
    if (line.rule) {
      el.dataset.rule = '1';   /* fill at layout time */
    } else {
      /* wrap every visible character in a <span class="ch"> while
         keeping the inline emphasis markup intact. */
      el.innerHTML = line.html;
      wrapTextNodeChars(el);
    }
    target.appendChild(el);
  }
  /* fill any .rule lines now that we know the rendered content width. */
  fillRules(target);
}

/* Group `.ch` spans by visual row using their bounding-rect `top`.
   Chars sharing a row land within ~2 px of each other; a larger gap
   marks a line wrap. The first getBoundingClientRect() call forces
   a layout pass but subsequent calls in the same loop are cheap. */
function groupByVisualRow(spans) {
  if (!spans.length) return [];
  const groups = [];
  let currentTop = null;
  let currentGroup = null;
  for (const span of spans) {
    const top = span.getBoundingClientRect().top;
    if (currentTop === null || Math.abs(top - currentTop) > 3) {
      currentGroup = [];
      groups.push(currentGroup);
      currentTop = top;
    }
    currentGroup.push(span);
  }
  return groups;
}

function wrapTextNodeChars(root) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes = [];
  let n;
  while (n = walker.nextNode()) nodes.push(n);
  for (const node of nodes) {
    const text = node.textContent;
    if (!text) continue;
    /* Inherit `strike` from any ancestor up to (and including) the
       root, so per-char .ch spans render the strike themselves —
       paints progressively in sync with print rather than appearing
       wholesale on the parent inline-span / line. */
    let isStrike = !!(root.classList && root.classList.contains('strike'));
    if (!isStrike) {
      let p = node.parentNode;
      while (p && p !== root.parentNode) {
        if (p.classList && p.classList.contains('strike')) { isStrike = true; break; }
        p = p.parentNode;
      }
    }
    const cls = isStrike ? 'ch strike' : 'ch';
    const frag = document.createDocumentFragment();
    for (const ch of text) {
      if (ch === ' ' /* nbsp */) {
        const span = document.createElement('span');
        span.className = cls;
        span.innerHTML = '&nbsp;';
        frag.appendChild(span);
        continue;
      }
      const span = document.createElement('span');
      span.className = cls;
      span.textContent = ch;
      frag.appendChild(span);
    }
    node.replaceWith(frag);
  }
}

/* Generate a dotted-rule string sized to the receipt's content width
   in its current font. Runs after the receipt is in the DOM so we can
   measure. */
function fillRules(receipt) {
  const ruleLines = receipt.querySelectorAll('.line.rule[data-rule]');
  if (!ruleLines.length) return;
  /* probe character width with a hidden span — using getComputedStyle
     on the rule element so we pick up the .rule font-size. */
  const sample = receipt.querySelector('.line.rule[data-rule]');
  if (!sample) return;
  const probe = document.createElement('span');
  probe.style.cssText = 'visibility:hidden;letter-spacing:0.18em;';
  probe.textContent = '· ';
  sample.appendChild(probe);
  const cs = getComputedStyle(sample);
  /* sample's clientWidth = padding-box width of the line, which is
     what we want to fill. */
  const width = sample.clientWidth || 200;
  const groupW = probe.getBoundingClientRect().width || 8;
  sample.removeChild(probe);
  const count = Math.max(3, Math.floor(width / groupW));
  const str = Array.from({ length: count }, () => '·').join(' ');
  for (const r of ruleLines) {
    r.textContent = str;
    wrapTextNodeChars(r);
    r.removeAttribute('data-rule');
  }
}

/* Per-char animated print. Resolves when done. Calls onChar(ch, ev)
   for each printed character so the audio layer can fire sounds. */
export function printReceipt(target, opts = {}) {
  const { charMs = 7, linePauseMs = 140, onChar = null, onLineStart = null,
          onPrintStart = null, onPrintEnd = null, signal = null } = opts;
  /* Idle traversal (head moving across positions where it doesn't
     fire a pin) is faster than the print pace, like a real DMP whose
     carriage motor outruns the firing cycle. Aggressive ratio
     because for wide receipts (`cols=200` etc.) `.right` after
     left-aligned content otherwise spends most of the print just
     moving the head across blank paper. */
  const skipMs = charMs * 0.12;

  const lines = Array.from(target.querySelectorAll('.line'));
  const events = [];
  const lineStarts = [];
  let t = 0;

  /* Virtual head x-position in viewport coords. The head doesn't
     teleport between visual rows — it moves at a constant rate of
     one chWidth per lineCharMs, including across the silent gaps
     where there's no char to fire on. So `.right very much` after
     a left-aligned line requires the head to physically traverse
     to the right edge first.

     Init to the leftmost content x of the receipt so the first
     non-trivial char starts from col 0. */
  const firstCh = target.querySelector('.ch');
  /* Clamp to ≥1 px so the travel / elapsed math can't divide by zero
     (which would propagate Infinity through every event time and
     trip AudioParam.setValueAtTime's finite-value check). */
  const chWidth = Math.max(1,
    firstCh ? firstCh.getBoundingClientRect().width : 9);
  const receiptRect = target.getBoundingClientRect();
  const padLeft = parseFloat(getComputedStyle(target).paddingLeft) || 0;
  let headX = receiptRect.left + padLeft;

  /* Global visual-row counter — bidirectional alternation tied to
     this rather than logical-line index, so a wrapped paragraph's
     rows alternate the same way. */
  let visualRow = 0;

  for (let li = 0; li < lines.length; li++) {
    const line = lines[li];
    const allSpans = Array.from(line.querySelectorAll('.ch'));
    const bold = line.classList.contains('title')
              || line.querySelector('.strong');
    const lineCharMs = bold ? charMs * 2 : charMs;

    /* Detect visual row breaks via bounding-rect top — chars on the
       same wrapped row share a `top` (within a couple px). */
    const groups = groupByVisualRow(allSpans);

    if (!groups.length) {
      /* empty logical line — paper feed only, head stays put. */
      lineStarts.push({ t, line, ltr: true, bold, charMs: lineCharMs, lineLen: 0 });
      events.push({ kind: 'lineStart', t, line, ltr: true, bold });
      if (li < lines.length - 1) t += linePauseMs;
      continue;
    }

    for (let gi = 0; gi < groups.length; gi++) {
      const group = groups[gi];
      const hasContent = group.some(s => s.textContent.trim());
      const moreInThisLine = gi < groups.length - 1;
      const moreAfter = li < lines.length - 1;

      if (!hasContent) {
        /* whitespace-only row: paper feed, head doesn't move. */
        lineStarts.push({ t, line, ltr: true, bold, charMs: lineCharMs, lineLen: 0 });
        events.push({ kind: 'lineStart', t, line, ltr: true, bold });
        if (moreInThisLine || moreAfter) t += linePauseMs;
        continue;
      }

      /* Per-char x positions, then row's content range. */
      const charsWithX = group.map(span => ({
        span,
        x: span.getBoundingClientRect().left
      }));
      const minX = Math.min(...charsWithX.map(c => c.x));
      const maxX = Math.max(...charsWithX.map(c => c.x));

      const ltr = (visualRow % 2 === 0);
      const startX = ltr ? minX : maxX;
      const endX   = ltr ? maxX : minX;

      /* Silent traversal from current head to the row's start edge —
         uses the faster skip rate since no pins fire. */
      const travelToStartMs = Math.abs(startX - headX) / chWidth * skipMs;
      t += travelToStartMs;

      const ordered = ltr
        ? [...charsWithX].sort((a, b) => a.x - b.x)
        : [...charsWithX].sort((a, b) => b.x - a.x);
      const lineLen = ordered.length;
      lineStarts.push({ t, line, ltr, bold, charMs: lineCharMs, lineLen });
      events.push({ kind: 'lineStart', t, line, ltr, bold });

      /* Within a row, each char advances by a fixed per-step time
         regardless of pixel distance (chars are uniformly spaced
         within a font — measuring per-pixel distance via getBCR was
         destabilising because letter-spacing isn't reflected in the
         span's width). Whitespace steps use the faster skip rate;
         non-whitespace steps use the full print rate. Each event
         carries its own step time so the audio layer can spread the
         pin cluster across the letter's traversal. */
      const N = Math.max(1, lineLen - 1);
      let elapsed = 0;
      for (let ci = 0; ci < lineLen; ci++) {
        const { span } = ordered[ci];
        const isWhitespace = !span.textContent.trim();
        const stepMs = isWhitespace ? skipMs : lineCharMs;
        events.push({
          kind: 'char', t: t + elapsed, span, ltr, bold,
          linePos: ci / N,
          stepMs
        });
        elapsed += stepMs;
      }

      /* advance t past the row sweep + update head */
      t += elapsed;
      headX = endX;

      if (moreInThisLine || moreAfter) t += linePauseMs;
      visualRow++;
    }
  }

  /* Events were inserted in the order they were generated but a
     char's effective time uses an offset from line-start, so the
     array may not be strictly t-sorted between adjacent rows.
     Stable-sort by t so the rAF loop fires them in time order. */
  events.sort((a, b) => a.t - b.t);

  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) { reject(new DOMException('aborted', 'AbortError')); return; }
    if (onPrintStart) onPrintStart({ events, lineStarts, totalMs: t, linePauseMs });

    const start = performance.now();
    let i = 0;
    const tick = () => {
      if (signal && signal.aborted) {
        if (onPrintEnd) onPrintEnd({ aborted: true });
        reject(new DOMException('aborted', 'AbortError'));
        return;
      }
      const elapsed = performance.now() - start;
      while (i < events.length && events[i].t <= elapsed) {
        const ev = events[i++];
        if (ev.kind === 'lineStart') {
          if (onLineStart) onLineStart(ev);
        } else if (ev.kind === 'char') {
          ev.span.classList.add('printed');
          if (onChar) onChar(ev);
        }
      }
      if (i < events.length) requestAnimationFrame(tick);
      else {
        if (onPrintEnd) onPrintEnd({ aborted: false });
        resolve();
      }
    };
    requestAnimationFrame(tick);
  });
}


/* PNG export via SVG foreignObject — same approach as void-land's
   downloadReceiptAsImage. Inlines all stylesheets + woff fonts so the
   rasterised SVG matches the on-screen rendering exactly. */

let cachedDownloadStyles = null;
async function getDownloadStyles() {
  if (cachedDownloadStyles) return cachedDownloadStyles;

  let cssText = '';
  for (const sheet of Array.from(document.styleSheets)) {
    try {
      const baseUrl = sheet.href || document.baseURI;
      const sheetText = Array.from(sheet.cssRules).map(r => r.cssText).join('\n');
      const absolutized = sheetText.replace(
        /url\(\s*["']?([^"')]+)["']?\s*\)/g,
        (m, url) => {
          if (/^(?:data|https?):/i.test(url)) return m;
          try { return `url("${new URL(url, baseUrl).href}")`; }
          catch { return m; }
        }
      );
      cssText += absolutized + '\n';
    } catch { /* CORS-locked sheet */ }
  }

  const fontUrls = [...cssText.matchAll(/url\(\s*["']?([^"')]+\.woff2?)["']?\s*\)/g)]
    .map(m => m[1]);
  const unique = [...new Set(fontUrls)];
  for (const url of unique) {
    try {
      const resp = await fetch(url);
      const buf = await resp.arrayBuffer();
      let b64 = '';
      const bytes = new Uint8Array(buf);
      const chunk = 0x8000;
      for (let i = 0; i < bytes.length; i += chunk) {
        b64 += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
      }
      b64 = btoa(b64);
      const mime = url.endsWith('.woff2') ? 'font/woff2' : 'font/woff';
      const dataUri = `url("data:${mime};base64,${b64}")`;
      cssText = cssText.split(`url("${url}")`).join(dataUri);
      cssText = cssText.split(`url('${url}')`).join(dataUri);
      cssText = cssText.split(`url(${url})`).join(dataUri);
    } catch (e) {
      console.warn('font embed failed for', url, e);
    }
  }

  cachedDownloadStyles = cssText;
  return cssText;
}

export async function downloadReceiptAsPNG(el, filename = 'receipt.png') {
  /* render with all chars / lines revealed regardless of animation
     state so download doesn't catch a half-printed receipt. */
  const clone = el.cloneNode(true);
  clone.classList.add('skip-anim');
  for (const ch of clone.querySelectorAll('.ch')) ch.classList.add('printed');

  const rect = el.getBoundingClientRect();
  const w = Math.ceil(rect.width);
  const h = Math.max(40, Math.ceil(rect.height));

  /* repeating-linear-gradient doesn't reliably tile inside SVG
     foreignObject across Chrome / Safari. Expand it into explicit
     alternating stops to cover the full height with no tiling. */
  const rootFontSize = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
  const lineHpx = parseFloat(getComputedStyle(el).lineHeight) || 1.4 * rootFontSize;
  const numStripes = Math.ceil(h / lineHpx) + 2;
  const stops = [];
  for (let i = 0; i < numStripes; i++) {
    const y0 = (i * lineHpx).toFixed(2);
    const y1 = ((i + 1) * lineHpx).toFixed(2);
    const color = i % 2 === 0 ? '#f3eedd' : '#e8efe0';
    stops.push(`${color} ${y0}px`, `${color} ${y1}px`);
  }
  clone.style.width = w + 'px';
  clone.style.setProperty('--line-h', lineHpx + 'px');
  clone.style.backgroundImage = `linear-gradient(to bottom, ${stops.join(', ')})`;
  clone.style.backgroundColor = '#f3eedd';
  clone.style.backgroundRepeat = 'no-repeat';
  clone.style.backgroundSize = '100% 100%';

  const styles = await getDownloadStyles();
  const xml = new XMLSerializer().serializeToString(clone);
  const wrapperStyle = `font-size:${rootFontSize}px;font-family:ui-sans-serif,system-ui,sans-serif;`;
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">` +
      `<foreignObject width="100%" height="100%">` +
        `<div xmlns="http://www.w3.org/1999/xhtml" style="${wrapperStyle}">` +
          `<style>${styles}</style>` +
          xml +
        `</div>` +
      `</foreignObject>` +
    `</svg>`;

  const blob = new Blob([svg], { type: 'image/svg+xml;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const img = new Image();
  await new Promise((resolve, reject) => {
    img.onload = resolve;
    img.onerror = reject;
    img.src = url;
  });

  const dpr = 2;
  const canvas = document.createElement('canvas');
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  ctx.drawImage(img, 0, 0);
  URL.revokeObjectURL(url);

  await new Promise((resolve) => {
    canvas.toBlob((b) => {
      if (!b) { resolve(); return; }
      const dlUrl = URL.createObjectURL(b);
      const a = document.createElement('a');
      a.href = dlUrl;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(dlUrl), 1000);
      resolve();
    }, 'image/png');
  });
}
