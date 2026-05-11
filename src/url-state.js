/* URL hash <-> state. Values are URL-safe base64 for strings (so user
   text doesn't blow up the URL with %XX escapes) and stringified for
   primitives.

   shape: #k=v&k=v... where each `v` is plain for primitives or
   `b64:...` for base64-encoded text. */

function toB64(s) {
  /* utf-8 → bytes → base64 → URL-safe */
  const bytes = new TextEncoder().encode(s);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromB64(s) {
  let bin = s.replace(/-/g, '+').replace(/_/g, '/');
  while (bin.length % 4) bin += '=';
  const raw = atob(bin);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

export function encodeState(state) {
  const parts = [];
  for (const [k, v] of Object.entries(state)) {
    if (v === undefined || v === null) continue;
    if (typeof v === 'boolean') parts.push(`${k}=${v ? '1' : '0'}`);
    else if (typeof v === 'number') parts.push(`${k}=${v}`);
    else if (typeof v === 'string') {
      /* short strings → plain (percent-escaped); longer → base64. */
      const useB64 = v.length > 20 || /[#&%?]/.test(v);
      parts.push(useB64 ? `${k}=b64:${toB64(v)}` : `${k}=${encodeURIComponent(v)}`);
    }
  }
  return parts.join('&');
}

export function decodeState(hash) {
  const out = {};
  for (const pair of hash.replace(/^#/, '').split('&')) {
    if (!pair) continue;
    const eq = pair.indexOf('=');
    if (eq < 0) continue;
    const k = pair.substring(0, eq);
    const v = pair.substring(eq + 1);
    if (v.startsWith('b64:')) {
      try { out[k] = fromB64(v.substring(4)); } catch { out[k] = ''; }
    } else {
      out[k] = decodeURIComponent(v);
    }
  }
  return out;
}

/* Replaces the URL hash without triggering navigation or history. */
export function pushHash(state) {
  const s = encodeState(state);
  const newHash = s ? '#' + s : '#';
  if (location.hash !== newHash) {
    history.replaceState(null, '', newHash);
  }
}

export function readHash() {
  return decodeState(location.hash);
}
