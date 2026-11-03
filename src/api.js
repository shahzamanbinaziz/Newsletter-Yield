const express = require('express');
const db = require('./db');
const config = require('./config');
const U = require('./util');
const mailer = require('./mailer');
const { renderSignature } = require('./signature');

const r = express.Router();
const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const bad = (m, status = 400) => Object.assign(new Error(m), { status });
const get = (sql, ...a) => db.prepare(sql).get(...a);
const all = (sql, ...a) => db.prepare(sql).all(...a);
const run = (sql, ...a) => db.prepare(sql).run(...a);
const str = (v, max = 200) => String(v ?? '').trim().slice(0, max);

/* ---------- login (public) ---------- */
const fails = new Map();
r.post('/login', (req, res) => {
  const f = fails.get(req.ip) || { n: 0, t: Date.now() };
  if (Date.now() - f.t > 15 * 60 * 1000) { f.n = 0; f.t = Date.now(); }
  if (f.n >= 10) throw bad('Too many attempts. Try again in 15 minutes.', 429);
  const { email = '', password = '' } = req.body || {};
  const okEmail = U.safeEqual(String(email).toLowerCase().trim(), config.adminEmail);
  const okPass = U.safeEqual(String(password), config.adminPassword);
  if (!(okEmail && okPass)) {
    f.n++; fails.set(req.ip, f);
    throw bad('Wrong email or password.', 401);
  }
  fails.delete(req.ip);
  res.json({ token: U.makeAuthToken(config.adminEmail), email: config.adminEmail });
});

r.use((req, res, next) => {
  const t = (req.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (!U.verifyAuthToken(t)) return res.status(401).json({ error: 'Please sign in.' });
  next();
});

const requireCompany = (req) => {
  const id = Number(req.query.company_id || (req.body && req.body.company_id));
  const c = get('SELECT * FROM companies WHERE id=?', id);
  if (!c) throw bad('Select a company first.');
  return c;
};

/* ---------- companies and signature ---------- */
const pubCompany = (c) => ({ ...c, signature: U.parseJson(c.signature_json, {}), signature_json: undefined });

function cleanSignature(s) {
  s = s && typeof s === 'object' ? s : {};
  const socials = {};
  for (const k of ['linkedin', 'x', 'instagram', 'facebook', 'youtube']) if (s.socials && s.socials[k]) socials[k] = str(s.socials[k], 300);
  return {
    template: ['classic', 'modern', 'minimal'].includes(s.template) ? s.template : 'classic',
    name: str(s.name, 100), title: str(s.title, 100), phone: str(s.phone, 40), email: str(s.email, 120),
    website: str(s.website, 200), tagline: str(s.tagline, 160), logo_url: str(s.logo_url, 500),
    color: /^#[0-9a-fA-F]{6}$/.test(s.color || '') ? s.color : '', socials,
  };
}

function companyFields(b, existing) {
  const name = str(b.name, 120) || (existing && existing.name);
  if (!name) throw bad('Company name is required.');
  const color = /^#[0-9a-fA-F]{6}$/.test(b.brand_color || '') ? b.brand_color : (existing ? existing.brand_color : '#4B2A8A');
  return {
    name, color,
    website: str(b.website ?? (existing && existing.website), 200),
    logo: str(b.logo_url ?? (existing && existing.logo_url), 500),
    address: str(b.address ?? (existing && existing.address), 300),
    sig: JSON.stringify(cleanSignature(b.signature ?? (existing && U.parseJson(existing.signature_json, {})))),
  };
}

r.get('/companies', (req, res) => {
  const rows = all(`SELECT c.*,
    (SELECT COUNT(*) FROM contacts WHERE company_id=c.id AND status='active') AS contacts,
    (SELECT COUNT(*) FROM campaigns WHERE company_id=c.id) AS campaigns,
    (SELECT COUNT(*) FROM mailboxes WHERE company_id=c.id) AS mailboxes FROM companies c ORDER BY c.name`);
  res.json(rows.map(pubCompany));
});
r.post('/companies', (req, res) => {
  const f = companyFields(req.body || {});
  const id = run('INSERT INTO companies(name,website,logo_url,brand_color,address,signature_json,created_at) VALUES(?,?,?,?,?,?,?)',
    f.name, f.website, f.logo, f.color, f.address, f.sig, U.now()).lastInsertRowid;
  res.json(pubCompany(get('SELECT * FROM companies WHERE id=?', id)));
});
r.put('/companies/:id', (req, res) => {
  const ex = get('SELECT * FROM companies WHERE id=?', req.params.id);
  if (!ex) throw bad('Company not found.', 404);
  const f = companyFields(req.body || {}, ex);
  run('UPDATE companies SET name=?,website=?,logo_url=?,brand_color=?,address=?,signature_json=? WHERE id=?',
    f.name, f.website, f.logo, f.color, f.address, f.sig, ex.id);
  res.json(pubCompany(get('SELECT * FROM companies WHERE id=?', ex.id)));
});
r.delete('/companies/:id', (req, res) => {
  run('DELETE FROM companies WHERE id=?', req.params.id);
  res.json({ ok: true });
});

// Live preview for the signature designer (nothing is saved).
r.post('/signature/preview', (req, res) => {
  const b = req.body || {};
  const company = { name: str(b.company && b.company.name), website: str(b.company && b.company.website), logo_url: str(b.company && b.company.logo_url), brand_color: (b.company && b.company.brand_color) || '#4B2A8A' };
  const mb = b.mailbox_id ? get('SELECT * FROM mailboxes WHERE id=?', b.mailbox_id) : null;
  const sample = mb || { from_name: 'Your Name', from_email: 'you@company.com' };
  res.json({ html: renderSignature(company, sample, cleanSignature(b.signature)) || '<p style="font-family:Arial;color:#888">Fill in your name or title to see the signature.</p>' });
});

/* ---------- mailboxes ---------- */
const pubMailbox = (m) => {
  const { password_enc, ...rest } = m;
  return { ...rest, sent_today: m.sent_date === U.today() ? m.sent_today : 0, effective_limit: U.effectiveLimit(m) };
};

function mailboxFields(b, existing) {
  const e = existing || {};
  const host = str(b.host ?? e.host, 200);
  const port = Number(b.port ?? e.port);
  const from_email = str(b.from_email ?? e.from_email, 200).toLowerCase();
  if (!host) throw bad('SMTP host is required.');
  if (!(port > 0 && port < 65536)) throw bad('SMTP port is not valid.');
  if (!U.isEmail(from_email)) throw bad('From email is not valid.');
  const pw = b.password ? U.encrypt(String(b.password)) : e.password_enc;
  if (!pw) throw bad('SMTP password is required.');
  return {
    label: str(b.label ?? e.label, 80) || from_email,
    from_name: str(b.from_name ?? e.from_name, 100) || from_email,
    from_email, host, port,
    secure: (b.secure ?? e.secure) ? 1 : 0,
    username: str(b.username ?? e.username, 200) || from_email,
    pw,
    daily_limit: Math.max(1, Math.min(5000, Number(b.daily_limit ?? e.daily_limit ?? 150) || 150)),
    delay_seconds: Math.max(1, Math.min(600, Number(b.delay_seconds ?? e.delay_seconds ?? 5) || 5)),
    ramp_up: (b.ramp_up ?? e.ramp_up ?? 1) ? 1 : 0,
    sig_name: str(b.sig_name ?? e.sig_name, 100), sig_title: str(b.sig_title ?? e.sig_title, 100), sig_phone: str(b.sig_phone ?? e.sig_phone, 40),
  };
}

r.get('/mailboxes', (req, res) => {
  const c = requireCompany(req);
  res.json(all('SELECT * FROM mailboxes WHERE company_id=? ORDER BY id', c.id).map(pubMailbox));
});
r.post('/mailboxes', (req, res) => {
  const c = requireCompany(req);
  const f = mailboxFields(req.body || {});
  const id = run(`INSERT INTO mailboxes(company_id,label,from_name,from_email,host,port,secure,username,password_enc,daily_limit,delay_seconds,ramp_up,sig_name,sig_title,sig_phone,created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, c.id, f.label, f.from_name, f.from_email, f.host, f.port, f.secure, f.username, f.pw, f.daily_limit, f.delay_seconds, f.ramp_up, f.sig_name, f.sig_title, f.sig_phone, U.now()).lastInsertRowid;
  res.json(pubMailbox(get('SELECT * FROM mailboxes WHERE id=?', id)));
});
r.put('/mailboxes/:id', (req, res) => {
  const ex = get('SELECT * FROM mailboxes WHERE id=?', req.params.id);
  if (!ex) throw bad('Mailbox not found.', 404);
  const f = mailboxFields(req.body || {}, ex);
  run(`UPDATE mailboxes SET label=?,from_name=?,from_email=?,host=?,port=?,secure=?,username=?,password_enc=?,daily_limit=?,delay_seconds=?,ramp_up=?,sig_name=?,sig_title=?,sig_phone=? WHERE id=?`,
    f.label, f.from_name, f.from_email, f.host, f.port, f.secure, f.username, f.pw, f.daily_limit, f.delay_seconds, f.ramp_up, f.sig_name, f.sig_title, f.sig_phone, ex.id);
  res.json(pubMailbox(get('SELECT * FROM mailboxes WHERE id=?', ex.id)));
});
r.delete('/mailboxes/:id', (req, res) => {
  run("UPDATE messages SET status='failed', error='Mailbox was removed' WHERE mailbox_id=? AND status='queued'", req.params.id);
  run('DELETE FROM mailboxes WHERE id=?', req.params.id);
  res.json({ ok: true });
});
// Tests the SMTP login. If it works the mailbox is re-activated.
r.post('/mailboxes/:id/test', ah(async (req, res) => {
  const mb = get('SELECT * FROM mailboxes WHERE id=?', req.params.id);
  if (!mb) throw bad('Mailbox not found.', 404);
  try {
    await mailer.verify(mb);
    run("UPDATE mailboxes SET status='active', last_error='' WHERE id=?", mb.id);
    res.json({ ok: true });
  } catch (e) {
    const msg = String(e.response || e.message).slice(0, 300);
    run("UPDATE mailboxes SET status='error', last_error=? WHERE id=?", msg, mb.id);
    res.json({ ok: false, error: msg });
  }
}));

/* ---------- lists and contacts ---------- */
r.get('/lists', (req, res) => {
  const c = requireCompany(req);
  res.json(all(`SELECT l.*,
    (SELECT COUNT(*) FROM list_contacts lc JOIN contacts k ON k.id=lc.contact_id WHERE lc.list_id=l.id AND k.status='active') AS active_count,
    (SELECT COUNT(*) FROM list_contacts WHERE list_id=l.id) AS total FROM lists l WHERE l.company_id=? ORDER BY l.name`, c.id));
});
r.post('/lists', (req, res) => {
  const c = requireCompany(req);
  const name = str(req.body.name, 80);
  if (!name) throw bad('List name is required.');
  run('INSERT OR IGNORE INTO lists(company_id,name,created_at) VALUES(?,?,?)', c.id, name, U.now());
  res.json(get('SELECT * FROM lists WHERE company_id=? AND name=?', c.id, name));
});
r.delete('/lists/:id', (req, res) => {
  run('DELETE FROM lists WHERE id=?', req.params.id);
  res.json({ ok: true });
});

r.get('/contacts', (req, res) => {
  const c = requireCompany(req);
  const where = ['k.company_id=?'];
  const args = [c.id];
  if (req.query.list_id) { where.push('EXISTS (SELECT 1 FROM list_contacts lc WHERE lc.contact_id=k.id AND lc.list_id=?)'); args.push(Number(req.query.list_id)); }
  if (req.query.status) { where.push('k.status=?'); args.push(String(req.query.status)); }
  if (req.query.q) { where.push('(k.email LIKE ? OR k.first_name LIKE ? OR k.last_name LIKE ?)'); const q = '%' + String(req.query.q).slice(0, 80) + '%'; args.push(q, q, q); }
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  const offset = Number(req.query.offset) || 0;
  const total = get(`SELECT COUNT(*) n FROM contacts k WHERE ${where.join(' AND ')}`, ...args).n;
  const rows = all(`SELECT k.id,k.email,k.first_name,k.last_name,k.status,k.consent_source,k.consent_at,k.created_at FROM contacts k
    WHERE ${where.join(' AND ')} ORDER BY k.id DESC LIMIT ? OFFSET ?`, ...args, limit, offset);
  res.json({ total, rows });
});

// Import contacts. The person doing the import must confirm that these people agreed to receive email.
r.post('/contacts/import', (req, res) => {
  const c = requireCompany(req);
  const b = req.body || {};
  if (!b.confirmed) throw bad('Please confirm that these contacts agreed to receive your emails.');
  const consent = str(b.consent_source, 120);
  if (!consent) throw bad('Consent source is required (for example "website signup form").');
  const rows = Array.isArray(b.rows) ? b.rows.slice(0, 50000) : [];
  if (!rows.length) throw bad('No contacts to import.');

  let listId = Number(b.list_id) || null;
  if (!listId) {
    const name = str(b.list_name, 80) || 'Main list';
    run('INSERT OR IGNORE INTO lists(company_id,name,created_at) VALUES(?,?,?)', c.id, name, U.now());
    listId = get('SELECT id FROM lists WHERE company_id=? AND name=?', c.id, name).id;
  } else if (!get('SELECT id FROM lists WHERE id=? AND company_id=?', listId, c.id)) throw bad('List not found.');

  const out = { added: 0, updated: 0, invalid: 0, suppressed: 0, duplicates: 0 };
  const seen = new Set();
  const find = db.prepare('SELECT * FROM contacts WHERE company_id=? AND email=?');
  const insert = db.prepare('INSERT INTO contacts(company_id,email,first_name,last_name,consent_source,consent_at,token,created_at) VALUES(?,?,?,?,?,?,?,?)');
  const upd = db.prepare("UPDATE contacts SET first_name=CASE WHEN ?<>'' THEN ? ELSE first_name END, last_name=CASE WHEN ?<>'' THEN ? ELSE last_name END WHERE id=?");
  const link = db.prepare('INSERT OR IGNORE INTO list_contacts(list_id,contact_id) VALUES(?,?)');

  db.transaction(() => {
    for (const row of rows) {
      const email = str(row.email, 254).toLowerCase();
      if (!U.isEmail(email)) { out.invalid++; continue; }
      if (seen.has(email)) { out.duplicates++; continue; }
      seen.add(email);
      const first = str(row.first_name, 80), last = str(row.last_name, 80);
      const ex = find.get(c.id, email);
      if (ex) {
        if (ex.status !== 'active') { out.suppressed++; continue; } // unsubscribed or bounced people are never re-added
        upd.run(first, first, last, last, ex.id);
        link.run(listId, ex.id);
        out.updated++;
      } else {
        const id = insert.run(c.id, email, first, last, consent, U.now(), U.randomToken(), U.now()).lastInsertRowid;
        link.run(listId, id);
        out.added++;
      }
    }
  })();
  res.json({ ...out, list_id: listId });
});
r.delete('/contacts/:id', (req, res) => {
  const k = get('SELECT * FROM contacts WHERE id=?', req.params.id);
  if (!k) throw bad('Contact not found.', 404);
  if (k.status !== 'active') throw bad('Unsubscribed and bounced contacts are kept so they are never emailed again.');
  run('DELETE FROM contacts WHERE id=?', k.id);
  res.json({ ok: true });
});
r.post('/contacts/:id/unsubscribe', (req, res) => {
  run("UPDATE contacts SET status='unsubscribed', unsubscribed_at=? WHERE id=? AND status='active'", U.now(), req.params.id);
  res.json({ ok: true });
});

/* ---------- campaigns ---------- */
function campaignFields(req, company, existing) {
  const b = req.body || {};
  const e = existing || {};
  const name = str(b.name ?? e.name, 120);
  if (!name) throw bad('Campaign name is required.');
  let listId = b.list_id === undefined ? e.list_id : (Number(b.list_id) || null);
  if (listId && !get('SELECT id FROM lists WHERE id=? AND company_id=?', listId, company.id)) throw bad('List not found.');
  let ids = Array.isArray(b.mailbox_ids) ? b.mailbox_ids.map(Number) : U.parseJson(e.mailbox_ids, []);
  ids = ids.filter((id) => get('SELECT id FROM mailboxes WHERE id=? AND company_id=?', id, company.id));
  const html = String(b.html ?? e.html ?? '').slice(0, 500000);
  return { name, subject: str(b.subject ?? e.subject, 200), preheader: str(b.preheader ?? e.preheader, 200), html, listId: listId || null, ids: JSON.stringify(ids) };
}
const pubCampaign = (c) => ({ ...c, mailbox_ids: U.parseJson(c.mailbox_ids, []) });

function statsFor(id) {
  const n = (sql, ...a) => get(sql, ...a).n;
  const total = n('SELECT COUNT(*) n FROM messages WHERE campaign_id=?', id);
  const byStatus = (s) => n('SELECT COUNT(*) n FROM messages WHERE campaign_id=? AND status=?', id, s);
  const uniq = (t) => n("SELECT COUNT(DISTINCT message_id) n FROM events WHERE campaign_id=? AND type=? AND bot=0", id, t);
  const sent = byStatus('sent');
  return {
    total, sent, queued: byStatus('queued'), failed: byStatus('failed'), skipped: byStatus('skipped'),
    opened: uniq('open'), clicked: uniq('click'), unsubscribed: uniq('unsubscribe'),
    total_clicks: n("SELECT COUNT(*) n FROM events WHERE campaign_id=? AND type='click' AND bot=0", id),
    bot_events: n('SELECT COUNT(*) n FROM events WHERE campaign_id=? AND bot=1', id),
  };
}

r.get('/campaigns', (req, res) => {
  const c = requireCompany(req);
  const rows = all('SELECT * FROM campaigns WHERE company_id=? ORDER BY id DESC', c.id);
  res.json(rows.map((x) => ({ ...pubCampaign(x), html: undefined, stats: statsFor(x.id) })));
});
r.post('/campaigns', (req, res) => {
  const c = requireCompany(req);
  const f = campaignFields(req, c);
  const id = run('INSERT INTO campaigns(company_id,name,subject,preheader,html,list_id,mailbox_ids,created_at) VALUES(?,?,?,?,?,?,?,?)',
    c.id, f.name, f.subject, f.preheader, f.html, f.listId, f.ids, U.now()).lastInsertRowid;
  res.json(pubCampaign(get('SELECT * FROM campaigns WHERE id=?', id)));
});
r.get('/campaigns/:id', (req, res) => {
  const c = get('SELECT * FROM campaigns WHERE id=?', req.params.id);
  if (!c) throw bad('Campaign not found.', 404);
  res.json({ ...pubCampaign(c), stats: statsFor(c.id) });
});
r.put('/campaigns/:id', (req, res) => {
  const ex = get('SELECT * FROM campaigns WHERE id=?', req.params.id);
  if (!ex) throw bad('Campaign not found.', 404);
  if (!['draft', 'scheduled'].includes(ex.status)) throw bad('Only draft or scheduled campaigns can be edited.');
  const company = get('SELECT * FROM companies WHERE id=?', ex.company_id);
  const f = campaignFields(req, company, ex);
  run('UPDATE campaigns SET name=?,subject=?,preheader=?,html=?,list_id=?,mailbox_ids=? WHERE id=?', f.name, f.subject, f.preheader, f.html, f.listId, f.ids, ex.id);
  res.json(pubCampaign(get('SELECT * FROM campaigns WHERE id=?', ex.id)));
});
r.delete('/campaigns/:id', (req, res) => {
  const ex = get('SELECT status FROM campaigns WHERE id=?', req.params.id);
  if (ex && ex.status === 'sending') throw bad('Pause the campaign before deleting it.');
  run('DELETE FROM campaigns WHERE id=?', req.params.id);
  res.json({ ok: true });
});

r.post('/campaigns/:id/schedule', (req, res) => {
  const c = get('SELECT * FROM campaigns WHERE id=?', req.params.id);
  if (!c) throw bad('Campaign not found.', 404);
  if (!['draft', 'scheduled'].includes(c.status)) throw bad('This campaign was already started.');
  if (!c.subject.trim()) throw bad('Add a subject line first.');
  if (!c.html.trim()) throw bad('The email has no content yet.');
  if (!c.list_id) throw bad('Choose a list to send to.');
  if (!U.parseJson(c.mailbox_ids, []).length) throw bad('Choose at least one mailbox to send from.');
  let at = req.body && req.body.at ? Date.parse(req.body.at) : Date.now();
  if (Number.isNaN(at) || at < Date.now()) at = Date.now();
  run("UPDATE campaigns SET status='scheduled', scheduled_at=?, note='' WHERE id=?", new Date(at).toISOString(), c.id);
  res.json(pubCampaign(get('SELECT * FROM campaigns WHERE id=?', c.id)));
});
r.post('/campaigns/:id/unschedule', (req, res) => {
  run("UPDATE campaigns SET status='draft', scheduled_at=NULL WHERE id=? AND status='scheduled'", req.params.id);
  res.json({ ok: true });
});
r.post('/campaigns/:id/pause', (req, res) => {
  run("UPDATE campaigns SET status='paused' WHERE id=? AND status='sending'", req.params.id);
  res.json({ ok: true });
});
r.post('/campaigns/:id/resume', (req, res) => {
  run("UPDATE campaigns SET status='sending' WHERE id=? AND status='paused'", req.params.id);
  res.json({ ok: true });
});

const SAMPLE = { first_name: 'Alex', last_name: 'Morgan', email: 'alex@example.com' };

// Live preview of the final email (body + company signature + footer), without tracking.
r.post('/campaigns/preview', (req, res) => {
  const c = requireCompany(req);
  const b = req.body || {};
  const mb = b.mailbox_id ? get('SELECT * FROM mailboxes WHERE id=? AND company_id=?', b.mailbox_id, c.id) : null;
  const built = mailer.buildEmail({
    campaign: { subject: str(b.subject, 200), preheader: str(b.preheader, 200), html: String(b.html || '').slice(0, 500000) },
    contact: SAMPLE, company: c, mailbox: mb, message: { token: 'preview' }, track: false,
  });
  res.json({ html: built.html, subject: built.subject });
});

r.post('/campaigns/:id/test', ah(async (req, res) => {
  const c = get('SELECT * FROM campaigns WHERE id=?', req.params.id);
  if (!c) throw bad('Campaign not found.', 404);
  const to = str(req.body && req.body.to, 254).toLowerCase();
  if (!U.isEmail(to)) throw bad('Enter a valid test email address.');
  const mb = get('SELECT * FROM mailboxes WHERE id=? AND company_id=?', Number(req.body && req.body.mailbox_id), c.company_id);
  if (!mb) throw bad('Choose a mailbox to send the test from.');
  const company = get('SELECT * FROM companies WHERE id=?', c.company_id);
  const built = mailer.buildEmail({ campaign: c, contact: { ...SAMPLE, email: to, first_name: 'there' }, company, mailbox: mb, message: { token: 'preview' }, track: false });
  built.subject = '[TEST] ' + built.subject;
  try {
    await mailer.send(mb, to, built);
    res.json({ ok: true });
  } catch (e) {
    res.json({ ok: false, error: String(e.response || e.message).slice(0, 300) });
  }
}));

r.get('/campaigns/:id/stats', (req, res) => {
  const c = get('SELECT * FROM campaigns WHERE id=?', req.params.id);
  if (!c) throw bad('Campaign not found.', 404);
  const links = all(`SELECT url, COUNT(*) AS clicks, COUNT(DISTINCT message_id) AS unique_clicks FROM events
    WHERE campaign_id=? AND type='click' AND bot=0 GROUP BY url ORDER BY clicks DESC LIMIT 10`, c.id);
  const timeline = all(`SELECT substr(created_at,1,13) AS hour,
    COUNT(DISTINCT CASE WHEN type='open' THEN message_id END) AS opens,
    COUNT(DISTINCT CASE WHEN type='click' THEN message_id END) AS clicks
    FROM events WHERE campaign_id=? AND bot=0 AND type IN ('open','click') GROUP BY hour ORDER BY hour DESC LIMIT 72`, c.id).reverse();
  res.json({ campaign: pubCampaign(c), stats: statsFor(c.id), links, timeline });
});

r.get('/campaigns/:id/recipients', (req, res) => {
  const id = Number(req.params.id);
  const filter = String(req.query.filter || 'all');
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  const offset = Number(req.query.offset) || 0;
  const base = `SELECT * FROM (SELECT m.id, k.email, k.first_name, k.status AS contact_status, m.status, m.sent_at, m.error,
    (SELECT COUNT(*) FROM events e WHERE e.message_id=m.id AND e.type='open' AND e.bot=0) AS opens,
    (SELECT COUNT(*) FROM events e WHERE e.message_id=m.id AND e.type='click' AND e.bot=0) AS clicks,
    (SELECT COUNT(*) FROM events e WHERE e.message_id=m.id AND e.type='unsubscribe') AS unsubs
    FROM messages m JOIN contacts k ON k.id=m.contact_id WHERE m.campaign_id=?)`;
  const cond = { all: '1=1', opened: 'opens>0', clicked: 'clicks>0', failed: "status='failed'", queued: "status='queued'", unsubscribed: 'unsubs>0' }[filter] || '1=1';
  const total = get(`SELECT COUNT(*) n FROM (${base}) WHERE ${cond}`.replace('SELECT * FROM (SELECT m.id', 'SELECT * FROM (SELECT m.id'), id).n;
  const rows = all(`${base} WHERE ${cond} ORDER BY id LIMIT ? OFFSET ?`, id, limit, offset);
  res.json({ total, rows });
});

/* ---------- overview ---------- */
r.get('/overview', (req, res) => {
  const c = requireCompany(req);
  const n = (sql, ...a) => get(sql, ...a).n;
  const since = new Date(Date.now() - 30 * 864e5).toISOString();
  const sent = n("SELECT COUNT(*) n FROM messages m JOIN campaigns c ON c.id=m.campaign_id WHERE c.company_id=? AND m.status='sent' AND m.sent_at>=?", c.id, since);
  const ev = (t) => n('SELECT COUNT(DISTINCT e.message_id) n FROM events e JOIN campaigns c ON c.id=e.campaign_id WHERE c.company_id=? AND e.type=? AND e.bot=0 AND e.created_at>=?', c.id, t, since);

  const days = [];
  for (let i = 13; i >= 0; i--) days.push(new Date(Date.now() - i * 864e5).toISOString().slice(0, 10));
  const since14 = days[0];
  const series = (sql) => Object.fromEntries(all(sql, c.id, since14).map((x) => [x.d, x.n]));
  const sentBy = series("SELECT substr(m.sent_at,1,10) d, COUNT(*) n FROM messages m JOIN campaigns c ON c.id=m.campaign_id WHERE c.company_id=? AND m.status='sent' AND substr(m.sent_at,1,10)>=? GROUP BY d");
  const openBy = series("SELECT substr(e.created_at,1,10) d, COUNT(DISTINCT e.message_id) n FROM events e JOIN campaigns c ON c.id=e.campaign_id WHERE c.company_id=? AND e.type='open' AND e.bot=0 AND substr(e.created_at,1,10)>=? GROUP BY d");
  const clickBy = series("SELECT substr(e.created_at,1,10) d, COUNT(DISTINCT e.message_id) n FROM events e JOIN campaigns c ON c.id=e.campaign_id WHERE c.company_id=? AND e.type='click' AND e.bot=0 AND substr(e.created_at,1,10)>=? GROUP BY d");

  res.json({
    sent_30d: sent, opened_30d: ev('open'), clicked_30d: ev('click'), unsubscribed_30d: ev('unsubscribe'),
    active_contacts: n("SELECT COUNT(*) n FROM contacts WHERE company_id=? AND status='active'", c.id),
    suppressed: n("SELECT COUNT(*) n FROM contacts WHERE company_id=? AND status<>'active'", c.id),
    campaigns: n('SELECT COUNT(*) n FROM campaigns WHERE company_id=?', c.id),
    mailboxes: n('SELECT COUNT(*) n FROM mailboxes WHERE company_id=?', c.id),
    timeline: days.map((d) => ({ day: d, sent: sentBy[d] || 0, opens: openBy[d] || 0, clicks: clickBy[d] || 0 })),
  });
});

module.exports = r;
