/* Minimal inline-markdown + per-line directives parser for receipts.

   Inline: **bold**, *italic*, ~~strikethrough~~. Nesting allowed
   left-to-right (e.g. `**bold *italic***`); we don't try to handle
   pathological overlap.

   Line directives (at start of line, with the leading dot, optionally
   followed by content):
     .center / .left / .right   alignment
     .title                     bigger centered heading
     .small                     smaller text
     .rule                      dotted rule (content ignored)
     .row LEFT  RIGHT           two-column row (split on 2+ spaces)

   Blank lines render as empty rows (preserves vertical spacing). */

const DIRECTIVES = new Set(['center', 'left', 'right', 'title', 'small', 'rule', 'row']);

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, ch => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[ch]));
}

/* Inline pass — operate on already-escaped text so the regex
   replacements only see the markdown sigils we care about. */
function inlineMd(escaped) {
  let s = escaped;
  /* strikethrough first so ~~**foo**~~ unwraps cleanly */
  s = s.replace(/~~([^~]+?)~~/g, '<span class="strike">$1</span>');
  /* bold (**...**) before italic (*...*) so ** doesn't get parsed
     as two italics */
  s = s.replace(/\*\*([^*]+?)\*\*/g, '<span class="strong">$1</span>');
  s = s.replace(/\*([^*]+?)\*/g, '<span class="em">$1</span>');
  return s;
}

function parseLine(raw) {
  const m = /^\s*\.([a-z]+)(?:\s+(.*))?$/.exec(raw);
  if (m && DIRECTIVES.has(m[1])) {
    return { directive: m[1], content: m[2] || '' };
  }
  return { directive: null, content: raw };
}

/* Returns an array of { classes, html } objects. */
export function parseReceipt(text) {
  const out = [];
  for (const raw of text.split('\n')) {
    const { directive, content } = parseLine(raw);

    if (directive === 'rule') {
      out.push({ classes: ['line', 'rule'], html: '', rule: true });
      continue;
    }

    if (directive === 'row') {
      const parts = content.split(/\s{2,}/);
      const left  = inlineMd(escapeHtml(parts[0] || ''));
      const right = inlineMd(escapeHtml(parts.slice(1).join('  ').trim()));
      out.push({
        classes: ['line', 'row'],
        html: `<span class="col-l">${left}</span><span class="col-r">${right}</span>`
      });
      continue;
    }

    /* alignment + emphasis-only directives */
    const classes = ['line'];
    if (directive === 'center') classes.push('center');
    else if (directive === 'right') classes.push('right');
    else if (directive === 'left')  classes.push('left');
    else if (directive === 'title') classes.push('title');
    else if (directive === 'small') classes.push('small');

    const html = inlineMd(escapeHtml(content || ''));
    out.push({ classes, html: html || '&nbsp;' });
  }
  return out;
}
