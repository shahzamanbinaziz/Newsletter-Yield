// Public tracking endpoints. These are the links and the pixel inside every email.
const express = require('express');
const db = require('./db');
const { now, linkSig, safeEqual, esc } = require('./util');

const r = express.Router();
const GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
// Link scanners and previewers open every link. They are saved but not counted as real people.
const BOT = /bot|crawl|spider|preview|scanner|slurp|curl|wget|python|headless|facebookexternalhit|proofpoint|mimecast|barracuda|safelinks/i;

function record(type, msg, url, req) {
  const ua = (req.get('user-agent') || '').slice(0, 300);
  const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim().slice(0, 64);
  db.prepare('INSERT INTO events(message_id,campaign_id,contact_id,type,url,ip,ua,bot,created_at) VALUES(?,?,?,?,?,?,?,?,?)')
    .run(msg.id, msg.campaign_id, msg.contact_id, type, url || '', ip, ua, BOT.test(ua) ? 1 : 0, now());
}
const findMsg = (token) => db.prepare('SELECT * FROM messages WHERE token=?').get(String(token).slice(0, 64));

r.get('/t/o/:file', (req, res) => {
  const msg = findMsg(req.params.file.replace(/\.gif$/i, ''));
  if (msg) record('open', msg, '', req);
  res.set({ 'Content-Type': 'image/gif', 'Content-Length': GIF.length, 'Cache-Control': 'no-store, no-cache, must-revalidate, private' });
  res.end(GIF);
});

r.get('/t/c/:token', (req, res) => {
  const url = String(req.query.u || '');
  const sig = String(req.query.s || '');
  if (!/^https?:\/\//i.test(url) || !safeEqual(linkSig(req.params.token, url), sig)) return res.status(400).send('Invalid link.');
  const msg = findMsg(req.params.token);
  if (msg) record('click', msg, url, req);
  res.redirect(302, url);
});

const page = (title, inner) => `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#f4f4f7;font-family:Arial,Helvetica,sans-serif;color:#222}
.c{background:#fff;border-radius:12px;padding:36px;max-width:420px;margin:16px;text-align:center;box-shadow:0 4px 24px rgba(0,0,0,.08)}
h1{font-size:22px;margin:0 0 12px}p{color:#555;line-height:1.5}button{background:#4B2A8A;color:#fff;border:0;border-radius:8px;padding:12px 24px;font-size:15px;font-weight:bold;cursor:pointer}</style></head>
<body><div class="c">${inner}</div></body></html>`;

function unsubInfo(token) {
  const msg = findMsg(token);
  if (!msg) return null;
  const contact = db.prepare('SELECT * FROM contacts WHERE id=?').get(msg.contact_id);
  const company = db.prepare('SELECT c.name FROM companies c JOIN campaigns k ON k.company_id=c.id WHERE k.id=?').get(msg.campaign_id);
  return { msg, contact, company };
}

// GET only shows a confirmation button, because mail security scanners "click" every link.
r.get('/t/u/:token', (req, res) => {
  if (req.params.token === 'preview') return res.send(page('Preview', '<h1>Preview only</h1><p>In a real email this link lets the reader unsubscribe.</p>'));
  const i = unsubInfo(req.params.token);
  if (!i) return res.status(404).send(page('Not found', '<h1>Link not found</h1><p>This unsubscribe link is not valid.</p>'));
  if (i.contact.status === 'unsubscribed') return res.send(page('Unsubscribed', `<h1>You are unsubscribed</h1><p>${esc(i.contact.email)} will not receive more emails from ${esc(i.company.name)}.</p>`));
  res.send(page('Unsubscribe', `<h1>Unsubscribe?</h1><p>Stop emails from <b>${esc(i.company.name)}</b> to ${esc(i.contact.email)}.</p>
<form method="post"><button type="submit">Yes, unsubscribe me</button></form>`));
});

// POST does the unsubscribe. Gmail/Yahoo "one-click unsubscribe" also sends a POST to this URL.
r.post('/t/u/:token', express.urlencoded({ extended: false }), (req, res) => {
  const i = unsubInfo(req.params.token);
  if (!i) return res.status(404).send(page('Not found', '<h1>Link not found</h1>'));
  if (i.contact.status === 'active') {
    db.prepare("UPDATE contacts SET status='unsubscribed', unsubscribed_at=? WHERE id=?").run(now(), i.contact.id);
    record('unsubscribe', i.msg, '', req);
  }
  res.send(page('Unsubscribed', `<h1>You are unsubscribed</h1><p>${esc(i.contact.email)} will not receive more emails from ${esc(i.company.name)}.</p>`));
});

module.exports = r;
