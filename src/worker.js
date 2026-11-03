// Background sender. Every second it:
//  1. starts campaigns that are due (creates one queued message per active contact)
//  2. lets each mailbox send ONE email if its delay has passed and its daily limit is not reached
//  3. marks campaigns as sent when nothing is left in the queue
const db = require('./db');
const config = require('./config');
const mailer = require('./mailer');
const { now, today, randomToken, parseJson, effectiveLimit } = require('./util');

const nextAt = new Map(); // mailbox id -> earliest time of the next send
let busy = false;

function launch(c) {
  db.transaction(() => {
    const ids = parseJson(c.mailbox_ids, []);
    const mbs = ids.length
      ? db.prepare(`SELECT id FROM mailboxes WHERE company_id=? AND status='active' AND id IN (${ids.map(() => '?').join(',')})`).all(c.company_id, ...ids)
      : [];
    if (!c.list_id || !mbs.length) {
      db.prepare("UPDATE campaigns SET status='failed', note=? WHERE id=?").run(!c.list_id ? 'No list selected.' : 'No active mailbox selected.', c.id);
      return;
    }
    const contacts = db.prepare(`SELECT c.id FROM contacts c JOIN list_contacts lc ON lc.contact_id=c.id
      WHERE lc.list_id=? AND c.company_id=? AND c.status='active' ORDER BY c.id`).all(c.list_id, c.company_id);
    const ins = db.prepare('INSERT INTO messages(campaign_id,contact_id,mailbox_id,token,created_at) VALUES(?,?,?,?,?)');
    contacts.forEach((ct, i) => ins.run(c.id, ct.id, mbs[i % mbs.length].id, randomToken(), now()));
    if (contacts.length) {
      db.prepare("UPDATE campaigns SET status='sending', started_at=?, note='' WHERE id=?").run(now(), c.id);
    } else {
      db.prepare("UPDATE campaigns SET status='sent', started_at=?, finished_at=?, note='List had no active contacts.' WHERE id=?").run(now(), now(), c.id);
    }
  })();
}

async function sendNext(mb) {
  if (Date.now() < (nextAt.get(mb.id) || 0)) return;

  if (mb.sent_date !== today()) {
    db.prepare('UPDATE mailboxes SET sent_date=?, sent_today=0 WHERE id=?').run(today(), mb.id);
    mb.sent_today = 0;
  }
  if (mb.sent_today >= effectiveLimit(mb)) return; // continues tomorrow

  const msg = db.prepare(`SELECT m.* FROM messages m JOIN campaigns c ON c.id=m.campaign_id
    WHERE m.mailbox_id=? AND m.status='queued' AND c.status='sending' ORDER BY m.id LIMIT 1`).get(mb.id);
  if (!msg) return;

  const gap = mb.delay_seconds * 1000 * (1 + Math.random() * 0.4); // small random jitter looks natural
  nextAt.set(mb.id, Date.now() + gap);

  const campaign = db.prepare('SELECT * FROM campaigns WHERE id=?').get(msg.campaign_id);
  const contact = db.prepare('SELECT * FROM contacts WHERE id=?').get(msg.contact_id);
  const company = db.prepare('SELECT * FROM companies WHERE id=?').get(campaign.company_id);

  // Someone may have unsubscribed after the campaign was queued.
  if (contact.status !== 'active') {
    db.prepare("UPDATE messages SET status='skipped', error=? WHERE id=?").run('Contact is ' + contact.status, msg.id);
    return;
  }

  try {
    const built = mailer.buildEmail({ campaign, contact, company, mailbox: mb, message: msg, track: true });
    await mailer.send(mb, contact.email, built);
    db.prepare("UPDATE messages SET status='sent', sent_at=?, error='' WHERE id=?").run(now(), msg.id);
    db.prepare('UPDATE mailboxes SET sent_today=sent_today+1, sent_date=? WHERE id=?').run(today(), mb.id);
  } catch (err) {
    handleError(mb, msg, contact, err);
  }
}

function handleError(mb, msg, contact, err) {
  const text = String(err.response || err.message || err).slice(0, 300);
  const code = err.responseCode;

  // Wrong password or provider says the sending limit is reached: pause the mailbox, keep messages queued.
  if (err.code === 'EAUTH' || /quota|limit exceeded|too many|rate limit|daily/i.test(text) && code >= 400) {
    db.prepare("UPDATE mailboxes SET status='error', last_error=? WHERE id=?").run(text, mb.id);
    return;
  }
  // Recipient address rejected permanently: do not retry, stop mailing this contact.
  if (err.code === 'EENVELOPE' || (code >= 500 && err.command === 'RCPT TO')) {
    db.prepare("UPDATE messages SET status='failed', error=? WHERE id=?").run(text, msg.id);
    if ([550, 551, 553, 554].includes(code)) db.prepare("UPDATE contacts SET status='bounced' WHERE id=?").run(contact.id);
    return;
  }
  // Anything else (timeouts, temporary errors): retry up to 3 times.
  const attempts = msg.attempts + 1;
  if (attempts >= 3) db.prepare("UPDATE messages SET status='failed', attempts=?, error=? WHERE id=?").run(attempts, text, msg.id);
  else {
    db.prepare('UPDATE messages SET attempts=?, error=? WHERE id=?').run(attempts, text, msg.id);
    nextAt.set(mb.id, Date.now() + 60000);
  }
}

async function tick() {
  if (busy) return;
  busy = true;
  try {
    for (const c of db.prepare("SELECT * FROM campaigns WHERE status='scheduled' AND scheduled_at<=?").all(now())) launch(c);

    const mbs = db.prepare(`SELECT * FROM mailboxes WHERE status='active' AND id IN (
      SELECT m.mailbox_id FROM messages m JOIN campaigns c ON c.id=m.campaign_id WHERE m.status='queued' AND c.status='sending')`).all();
    await Promise.all(mbs.map(sendNext));

    db.prepare(`UPDATE campaigns SET status='sent', finished_at=? WHERE status='sending'
      AND NOT EXISTS (SELECT 1 FROM messages WHERE campaign_id=campaigns.id AND status='queued')`).run(now());
  } catch (e) {
    console.error('worker error:', e);
  } finally {
    busy = false;
  }
}

function start() {
  setInterval(tick, config.tickMs);
  console.log('Sender worker running.');
}

module.exports = { start, tick };
