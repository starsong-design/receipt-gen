/* Minimal inline-markdown + per-line directives parser for receipts.

   Inline: **bold**, *italic*, ~~strikethrough~~.
   Escape any sigil with a backslash: \*, \~, \\, \., \t

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
     strike                    strikethrough the whole line
     rule                      dotted rule (content ignored)
     row LEFT\tRIGHT           two-column row (split on a literal \t)

   Lines that DON'T start with a `.directive` are rendered verbatim,
   including any leading whitespace — type spaces to indent.
   Multiple consecutive spaces are preserved (each char becomes its
   own non-breaking span at render time).

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
const ESC_TAB    = '';

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
    .replace(/\\\./g, ESC_DOT)
    .replace(/\\t/g, ESC_TAB);
}

/* Split a `.row` line on a literal `\t` (or an actual tab char).
   Inline spans like `**foo  bar**` or `~~strike  it~~` are masked
   first so the user can put double spaces inside them — only the
   tab character separates the columns now. */
function splitRowColumns(content) {
  const masks = [];
  const masked = content
    .replace(/(\*\*[^*]+?\*\*|\*[^*]+?\*|~~[^~]+?~~)/g, (m) => {
      const idx = masks.length;
      masks.push(m);
      return `\x00${idx}\x00`;
    });
  return masked.split(new RegExp(`[${ESC_TAB}\t]`)).map(part =>
    part.replace(/\x00(\d+)\x00/g, (_, i) => masks[Number(i)]));
}

function restoreEscapes(s) {
  return s
    .replace(new RegExp(ESC_BSLASH, 'g'), '\\')
    .replace(new RegExp(ESC_STAR, 'g'), '*')
    .replace(new RegExp(ESC_TILDE, 'g'), '~')
    .replace(new RegExp(ESC_DOT, 'g'), '.')
    /* In a non-row context `\t` doesn't have a separator meaning,
       so render it as four non-breaking spaces — a visible indent. */
    .replace(new RegExp(ESC_TAB, 'g'), '    ');
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

   If the first non-whitespace char ISN'T `.`, the line isn't a
   directive line at all — the raw content is preserved with leading
   spaces intact (so a user can indent by typing spaces). Same for
   `\.center` (escaped leading dot). */
function parseDirectives(raw) {
  if (raw.startsWith('\\.') || raw.startsWith(ESC_DOT)) {
    /* The applyEscapes pass already turned `\.` into ESC_DOT; either
       form means "this leading dot is literal". restoreEscapes later
       turns it back into a `.`. */
    return { directives: [], content: raw };
  }
  let peek = 0;
  while (peek < raw.length && raw[peek] === ' ') peek++;
  if (peek >= raw.length || raw[peek] !== '.') {
    return { directives: [], content: raw };
  }
  let i = peek;
  const directives = [];
  while (i < raw.length && raw[i] === '.') {
    let j = i + 1;
    while (j < raw.length && raw[j] >= 'a' && raw[j] <= 'z') j++;
    const name = raw.substring(i + 1, j);
    if (!DIRECTIVES.has(name)) break;
    directives.push(name);
    i = j;
    if (SOLO.has(name)) break;
    /* skip whitespace between directives, OR fall straight into
       another `.` for the no-space `.small.center` form */
    while (i < raw.length && raw[i] === ' ') i++;
  }
  /* No recognised directive — leave the line untouched (preserve
     leading whitespace etc.). */
  if (!directives.length) {
    return { directives: [], content: raw };
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
      const right = restoreEscapes(inlineMd(parts.slice(1).join('\t').trim()));
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
