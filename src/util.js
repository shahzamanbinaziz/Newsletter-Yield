const crypto = require('crypto');
const config = require('./config');

let _key;
const key = () => _key || (_key = crypto.scryptSync(config.secret, 'mailhub-v1', 32));

// AES-256-GCM: used to store SMTP passwords safely in the database.
function encrypt(text) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const ct = Buffer.concat([c.update(String(text), 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64');
}
function decrypt(s) {
  const b = Buffer.from(s, 'base64');
  const d = crypto.createDecipheriv('aes-256-gcm', key(), b.subarray(0, 12));
  d.setAuthTag(b.subarray(12, 28));
  return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8');
}

const b64u = (b) => Buffer.from(b).toString('base64url');
const hmac = (d) => crypto.createHmac('sha256', config.secret).update(d).digest('base64url');
const safeEqual = (a, b) => {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};
const randomToken = (n = 18) => crypto.randomBytes(n).toString('base64url');

function makeAuthToken(email, days = 7) {
  const p = b64u(JSON.stringify({ e: email, x: Date.now() + days * 864e5 }));
  return p + '.' + hmac('auth.' + p);
}
function verifyAuthToken(t) {
  if (!t || !t.includes('.')) return null;
  const [p, s] = t.split('.');
  if (!safeEqual(hmac('auth.' + p), s || '')) return null;
  try {
    const o = JSON.parse(Buffer.from(p, 'base64url').toString());
    return o.x > Date.now() ? o : null;
  } catch {
    return null;
  }
}

// Click links are signed so nobody can abuse /t/c/ as an open redirect.
const linkSig = (token, url) => hmac('link.' + token + '.' + url).slice(0, 22);

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const now = () => new Date().toISOString();
const today = () => new Date().toISOString().slice(0, 10);
const isEmail = (e) => typeof e === 'string' && e.length <= 254 && /^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[^\s@<>()",;:]{2,}$/.test(e);
const parseJson = (s, d) => { try { const v = JSON.parse(s); return v ?? d; } catch { return d; } };

// New mailboxes start slowly and grow daily. This protects the reputation of a fresh mailbox.
function effectiveLimit(mb) {
  let lim = mb.daily_limit;
  if (mb.ramp_up) {
    const days = Math.max(0, Math.floor((Date.now() - Date.parse(mb.created_at)) / 864e5));
    lim = Math.min(lim, 20 + days * 10);
  }
  return lim;
}

module.exports = { encrypt, decrypt, hmac, safeEqual, randomToken, makeAuthToken, verifyAuthToken, linkSig, esc, now, today, isEmail, parseJson, effectiveLimit };
