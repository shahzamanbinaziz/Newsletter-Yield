const nodemailer = require('nodemailer');
const config = require('./config');
const { decrypt, esc, linkSig } = require('./util');
const { renderSignature } = require('./signature');

function transportFor(mb) {
  return nodemailer.createTransport({
    host: mb.host,
    port: mb.port,
    secure: !!mb.secure, // true for port 465, false for 587 (STARTTLS is used automatically)
    auth: { user: mb.username, pass: decrypt(mb.password_enc) },
    connectionTimeout: 15000,
    greetingTimeout: 15000,
    socketTimeout: 30000,
    tls: { rejectUnauthorized: process.env.SMTP_ALLOW_SELF_SIGNED !== '1' },
  });
}

// {{first_name}}, {{first_name|there}} (fallback), {{last_name}}, {{email}}, {{company}}, {{unsubscribe_url}}
function fill(str, ctx, raw = false) {
  return String(str || '').replace(/\{\{\s*([a-z_]+)\s*(?:\|([^}]*))?\}\}/gi, (m, k, fallback) => {
    k = k.toLowerCase();
    if (!(k in ctx)) return m;
    const v = ctx[k] || (fallback || '').trim();
    return raw || k === 'unsubscribe_url' ? v : esc(v);
  });
}

function htmlToText(html) {
  return String(html)
    .replace(/<(style|script)[\s\S]*?<\/\1>/gi, '')
    .replace(/<a\s[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (m, href, t) => {
      const txt = t.replace(/<[^>]+>/g, '').trim();
      return txt && txt !== href ? `${txt} (${href})` : href;
    })
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|h[1-6]|li)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&middot;/g, '·')
    .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Builds the final email for one contact.
 *  track=true  -> links go through our tracking server, an open pixel is added
 *  track=false -> used for previews and test sends
 */
function buildEmail({ campaign, contact, company, mailbox, message, track }) {
  const unsubUrl = track ? `${config.baseUrl}/t/u/${message.token}` : `${config.baseUrl}/t/u/preview`;
  const ctx = {
    first_name: contact.first_name || '',
    last_name: contact.last_name || '',
    email: contact.email || '',
    company: company.name || '',
    unsubscribe_url: unsubUrl,
  };

  let body = fill(campaign.html, ctx);
  if (track) {
    body = body.replace(/href\s*=\s*(["'])(https?:\/\/[^"']+)\1/gi, (m, q, u) => {
      if (u.startsWith(unsubUrl)) return m;
      const clean = u.replace(/&amp;/g, '&');
      return `href=${q}${config.baseUrl}/t/c/${message.token}?u=${encodeURIComponent(clean)}&s=${linkSig(message.token, clean)}${q}`;
    });
  }

  const subject = fill(campaign.subject, ctx, true);
  const signature = renderSignature(company, mailbox) || '';
  const hasOwnUnsub = /\{\{\s*unsubscribe_url\s*\}\}/i.test(campaign.html || '');
  const footer = hasOwnUnsub ? '' : `<div style="margin-top:32px;padding-top:16px;border-top:1px solid #eeeeee;font-size:12px;line-height:1.6;color:#888888;text-align:center">
You are receiving this email because you subscribed to updates from ${esc(company.name)}.${company.address ? '<br>' + esc(company.address) : ''}<br>
<a href="${esc(unsubUrl)}" style="color:#888888">Unsubscribe</a></div>`;
  const pre = campaign.preheader
    ? `<div style="display:none;max-height:0;overflow:hidden;opacity:0;font-size:1px;line-height:1px">${esc(fill(campaign.preheader, ctx, true))}</div>`
    : '';
  const pixel = track ? `<img src="${config.baseUrl}/t/o/${message.token}.gif" width="1" height="1" alt="" style="display:block;width:1px;height:1px;border:0">` : '';

  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(subject)}</title></head>
<body style="margin:0;padding:0;background:#f4f4f7">${pre}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f4f4f7"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:640px;background:#ffffff;border-radius:8px"><tr>
<td style="padding:32px;font-family:Arial,Helvetica,sans-serif;font-size:16px;line-height:1.6;color:#222222">${body}${signature}${footer}</td></tr></table>
</td></tr></table>${pixel}</body></html>`;

  const headers = track
    ? { 'List-Unsubscribe': `<${unsubUrl}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' }
    : {};
  return { subject, html, text: htmlToText(html.replace(pixel, '')), headers };
}

async function send(mb, to, built) {
  return transportFor(mb).sendMail({
    from: { name: mb.from_name, address: mb.from_email },
    to,
    subject: built.subject,
    html: built.html,
    text: built.text,
    headers: built.headers,
  });
}

async function verify(mb) {
  return transportFor(mb).verify();
}

module.exports = { buildEmail, send, verify, htmlToText };
