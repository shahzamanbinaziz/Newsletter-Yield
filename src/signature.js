// Email signature designer. Output is table based HTML with inline styles,
// because that is what Gmail, Outlook and phone mail apps render reliably.
const { esc, parseJson } = require('./util');

const url = (u) => {
  u = String(u || '').trim();
  if (!u) return '';
  return /^https?:\/\//i.test(u) ? u : 'https://' + u;
};
const color = (c) => (/^#[0-9a-fA-F]{6}$/.test(c || '') ? c : '#4B2A8A');

// Combine company defaults, saved signature settings and (optional) sender mailbox details.
function merge(company, mailbox, override) {
  const s = override || parseJson(company.signature_json, {});
  const mb = mailbox || {};
  return {
    template: ['classic', 'modern', 'minimal'].includes(s.template) ? s.template : 'classic',
    name: mb.sig_name || s.name || mb.from_name || '',
    title: mb.sig_title || s.title || '',
    phone: mb.sig_phone || s.phone || '',
    email: s.email || mb.from_email || '',
    website: s.website || company.website || '',
    tagline: s.tagline || '',
    logo_url: s.logo_url || company.logo_url || '',
    color: color(s.color || company.brand_color),
    socials: s.socials || {},
    company: company.name || '',
  };
}

const SOCIAL_LABELS = { linkedin: 'LinkedIn', x: 'X', instagram: 'Instagram', facebook: 'Facebook', youtube: 'YouTube' };

function socialLinks(s) {
  const out = [];
  for (const k of Object.keys(SOCIAL_LABELS)) {
    const u = url(s.socials[k]);
    if (u) out.push(`<a href="${esc(u)}" style="color:${s.color};text-decoration:none;font-weight:bold">${SOCIAL_LABELS[k]}</a>`);
  }
  return out.join(' &nbsp;|&nbsp; ');
}

function contactLines(s) {
  const rows = [];
  if (s.phone) rows.push(`<span style="color:#888">T</span>&nbsp; ${esc(s.phone)}`);
  if (s.email) rows.push(`<span style="color:#888">E</span>&nbsp; <a href="mailto:${esc(s.email)}" style="color:#333;text-decoration:none">${esc(s.email)}</a>`);
  if (s.website) rows.push(`<span style="color:#888">W</span>&nbsp; <a href="${esc(url(s.website))}" style="color:#333;text-decoration:none">${esc(String(s.website).replace(/^https?:\/\//i, '').replace(/\/$/, ''))}</a>`);
  return rows.join('<br>');
}

const WRAP = 'font-family:Arial,Helvetica,sans-serif;font-size:13px;line-height:1.5;color:#333333;';

function classic(s) {
  const logo = s.logo_url
    ? `<td style="padding-right:16px;border-right:3px solid ${s.color};vertical-align:top"><img src="${esc(url(s.logo_url))}" alt="${esc(s.company)}" width="90" style="display:block;width:90px;max-width:90px;height:auto;border:0"></td>`
    : '';
  const role = [s.title, s.company].filter(Boolean).map(esc).join(' &middot; ');
  const soc = socialLinks(s);
  return `<table cellpadding="0" cellspacing="0" border="0" style="${WRAP}margin-top:28px"><tr>${logo}
<td style="padding-left:${s.logo_url ? 16 : 0}px;vertical-align:top">
<div style="font-size:17px;font-weight:bold;color:#111111">${esc(s.name)}</div>
${role ? `<div style="color:${s.color};font-weight:bold;margin-bottom:6px">${role}</div>` : ''}
<div>${contactLines(s)}</div>
${s.tagline ? `<div style="margin-top:8px;font-style:italic;color:#666">${esc(s.tagline)}</div>` : ''}
${soc ? `<div style="margin-top:8px;font-size:12px">${soc}</div>` : ''}
</td></tr></table>`;
}

function modern(s) {
  const role = [s.title, s.company].filter(Boolean).map(esc).join(' &middot; ');
  const soc = socialLinks(s);
  return `<table cellpadding="0" cellspacing="0" border="0" style="${WRAP}margin-top:28px;width:100%;max-width:460px"><tr><td style="border-top:4px solid ${s.color};padding-top:14px">
<div style="font-size:20px;font-weight:bold;color:#111111;letter-spacing:-0.3px">${esc(s.name)}</div>
${role ? `<div style="color:#666;margin-bottom:8px">${role}</div>` : ''}
<div>${contactLines(s)}</div>
${s.tagline ? `<div style="margin-top:8px;color:${s.color};font-weight:bold">${esc(s.tagline)}</div>` : ''}
${soc ? `<div style="margin-top:8px;font-size:12px">${soc}</div>` : ''}
${s.logo_url ? `<div style="margin-top:14px"><img src="${esc(url(s.logo_url))}" alt="${esc(s.company)}" width="120" style="display:block;width:120px;max-width:120px;height:auto;border:0"></div>` : ''}
</td></tr></table>`;
}

function minimal(s) {
  const role = [s.title, s.company].filter(Boolean).map(esc).join(', ');
  const bits = [];
  if (s.phone) bits.push(esc(s.phone));
  if (s.website) bits.push(`<a href="${esc(url(s.website))}" style="color:${s.color};text-decoration:none">${esc(String(s.website).replace(/^https?:\/\//i, '').replace(/\/$/, ''))}</a>`);
  const soc = socialLinks(s);
  return `<div style="${WRAP}margin-top:28px">
<div style="color:#999">--</div>
<div style="font-weight:bold;color:#111111">${esc(s.name)}</div>
${role ? `<div>${role}</div>` : ''}
${bits.length ? `<div>${bits.join(' &nbsp;|&nbsp; ')}</div>` : ''}
${soc ? `<div style="font-size:12px">${soc}</div>` : ''}
</div>`;
}

function renderSignature(company, mailbox, override) {
  const s = merge(company, mailbox, override);
  if (!s.name && !s.title && !s.phone && !s.website && !s.tagline) return '';
  return { classic, modern, minimal }[s.template](s);
}

module.exports = { renderSignature };
