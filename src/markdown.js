/* Minimal inline-markdown + per-line directives parser for receipts.

   Inline: **bold**, *italic*, ~~strikethrough~~.
   Escape any sigil with a backslash: \*, \~, \\, \.

   Line directives (start of line, with leading dot). Multiple may
   be chained, separated by whitespace OR by another dot:
     .small .center foo        ← small AND centered
     .small.center foo         ← same
     .center foo               ← centered
   Recognised:
     center / left / right     alignment
     title                     bigger centered heading
     small                     smaller text
     bold                      bold the whole line
     rule                      dotted rule (content ignored)
     row LEFT  RIGHT           two-column row (split on 2+ spaces)

   Blank lines render as empty rows (preserve vertical spacing). */

const ALIGN = new Set(['center', 'left', 'right']);
const SOLO  = new Set(['rule', 'row']);           /* consume rest of line */
const STYLE = new Set(['small', 'title', 'bold', 'strike']);
const DIRECTIVES = new Set([...ALIGN, ...SOLO, ...STYLE]);

/* private-use sentinels for escape preservation through markdown
   replacement. these get substituted back after the inline pass. */
const ESC_BSLASH = '';
const ESC_STAR   = '';
const ESC_TILDE  = '';
const ESC_DOT    = '';

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, ch => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[ch]));
}

function applyEscapes(s) {
  /* run BEFORE htmlescape so backslashes haven't been mangled */
  return s
    .replace(/\\\\/g, ESC_BSLASH)
    .replace(/\\\*/g, ESC_STAR)
    .replace(/\\~/g, ESC_TILDE)
    .replace(/\\\./g, ESC_DOT);
}

/* Split a `.row` line on 2+ spaces, but don't break inside an inline
   span like `**bold  text**` or `~~strike  through~~`. We mask those
   spans with placeholder tokens, split on whitespace, and reinsert. */
function splitRowColumns(content) {
  const masks = [];
  const masked = content
    .replace(/(\*\*[^*]+?\*\*|\*[^*]+?\*|~~[^~]+?~~)/g, (m) => {
      const idx = masks.length;
      masks.push(m);
      return `\x00${idx}\x00`;
    });
  return masked.split(/\s{2,}/).map(part =>
    part.replace(/\x00(\d+)\x00/g, (_, i) => masks[Number(i)]));
}

function restoreEscapes(s) {
  return s
    .replace(new RegExp(ESC_BSLASH, 'g'), '\\')
    .replace(new RegExp(ESC_STAR, 'g'), '*')
    .replace(new RegExp(ESC_TILDE, 'g'), '~')
    .replace(new RegExp(ESC_DOT, 'g'), '.');
}

/* Inline pass — runs on already-escape-replaced text so sigils we
   want literal don't trigger markdown. */
function inlineMd(text) {
  let s = escapeHtml(text);
  /* strikethrough first so `~~**foo**~~` unwraps cleanly */
  s = s.replace(/~~([^~]+?)~~/g, '<span class="strike">$1</span>');
  s = s.replace(/\*\*([^*]+?)\*\*/g, '<span class="strong">$1</span>');
  s = s.replace(/\*([^*]+?)\*/g, '<span class="em">$1</span>');
  return s;
}

/* Pulls a chain of directive tokens off the start of the line. A
   directive starts with `.`; chains may be separated by whitespace
   or by `.` directly (`.small.center foo`).

   `\.center` (backslash before the leading dot) opts out of
   directive parsing for that line — it renders as literal text
   starting with `.center`. */
function parseDirectives(raw) {
  if (raw.startsWith('\\.')) {
    return { directives: [], content: raw.substring(1) };
  }
  const directives = [];
  let i = 0;
  while (i < raw.length && raw[i] === ' ') i++;
  while (i < raw.length && raw[i] === '.') {
    let j = i + 1;
    while (j < raw.length && raw[j] >= 'a' && raw[j] <= 'z') j++;
    const name = raw.substring(i + 1, j);
    if (!DIRECTIVES.has(name)) break;
    directives.push(name);
    i = j;
    /* `row` and `rule` swallow the rest of the line as content */
    if (SOLO.has(name)) break;
    /* skip whitespace between directives, OR fall straight into
       another `.` for the no-space `.small.center` form */
    while (i < raw.length && raw[i] === ' ') i++;
  }
  return { directives, content: raw.substring(i) };
}

/* Returns an array of { classes, html, rule? } objects. */
export function parseReceipt(text) {
  const out = [];
  for (const raw of text.split('\n')) {
    const escaped = applyEscapes(raw);
    const { directives, content } = parseDirectives(escaped);

    if (directives.includes('rule')) {
      out.push({ classes: ['line', 'rule'], html: '', rule: true });
      continue;
    }

    if (directives.includes('row')) {
      const parts = splitRowColumns(content);
      const left  = restoreEscapes(inlineMd(parts[0] || ''));
      const right = restoreEscapes(inlineMd(parts.slice(1).join('  ').trim()));
      const classes = ['line', 'row'];
      /* a row can still carry style directives like .small.row */
      for (const d of directives) {
        if (STYLE.has(d)) classes.push(d);
      }
      out.push({
        classes,
        html: `<span class="col-l">${left}</span><span class="col-r">${right}</span>`
      });
      continue;
    }

    const classes = ['line'];
    /* alignment: last alignment wins (so `.center .right` → right) */
    for (const d of directives) {
      if (ALIGN.has(d)) {
        /* drop any prior alignment class */
        const idx = classes.findIndex(c => ALIGN.has(c));
        if (idx >= 0) classes.splice(idx, 1);
        classes.push(d);
      } else if (STYLE.has(d)) {
        if (!classes.includes(d)) classes.push(d);
      }
    }

    const html = restoreEscapes(inlineMd(content || '')) || '&nbsp;';
    out.push({ classes, html });
  }
  return out;
}
