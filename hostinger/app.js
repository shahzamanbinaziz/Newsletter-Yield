/* MailHub dashboard. Plain JavaScript, no build step, works on GitHub Pages. */
(() => {
'use strict';

const API = ((window.MAILHUB && window.MAILHUB.API_BASE) || '').replace(/\/+$/, '');
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* ignore */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* ignore */ } },
};
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const num = (n) => Number(n || 0).toLocaleString('en-US');
const pct = (a, b) => (b ? (Math.round((a / b) * 1000) / 10) + '%' : '0%');
const fdate = (iso) => (iso ? new Date(iso).toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '');
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

const state = { token: store.get('mh_token'), companies: [], cid: Number(store.get('mh_cid')) || null };
let timer = null;
const company = () => state.companies.find((c) => c.id === state.cid) || null;

/* ---------- API ---------- */
async function api(path, opts = {}) {
  let res;
  try {
    res = await fetch(API + '/api' + path, {
      method: opts.method || 'GET',
      headers: { 'Content-Type': 'application/json', ...(state.token ? { Authorization: 'Bearer ' + state.token } : {}) },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
  } catch {
    throw new Error('Cannot reach the server' + (API ? ' at ' + API : '') + '. Is it running?');
  }
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && path !== '/login') { logout(); throw new Error('Please sign in again.'); }
  if (!res.ok) throw new Error(data.error || 'Request failed (' + res.status + ')');
  return data;
}
const post = (p, body) => api(p, { method: 'POST', body: body || {} });
const put = (p, body) => api(p, { method: 'PUT', body });
const del = (p) => api(p, { method: 'DELETE' });
const qs = (p) => p + (p.includes('?') ? '&' : '?') + 'company_id=' + state.cid;

/* ---------- small UI helpers ---------- */
function toast(msg, kind = 'ok') {
  const t = document.createElement('div');
  t.className = 'toast ' + kind;
  t.textContent = msg;
  $('#toasts').appendChild(t);
  setTimeout(() => t.remove(), kind === 'bad' ? 7000 : 3200);
}
function modal(title, inner, { wide = false } = {}) {
  const o = document.createElement('div');
  o.className = 'overlay';
  o.innerHTML = `<div class="modal${wide ? ' wide' : ''}" role="dialog" aria-modal="true" aria-label="${esc(title)}">
    <div class="modal-head"><h2>${esc(title)}</h2><button class="x" aria-label="Close" type="button">&times;</button></div>
    <div class="modal-body">${inner}</div></div>`;
  document.body.appendChild(o);
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  const close = () => { o.remove(); document.removeEventListener('keydown', onKey); };
  document.addEventListener('keydown', onKey);
  $('.x', o).onclick = close;
  o.addEventListener('mousedown', (e) => { if (e.target === o) close(); });
  return { el: o, close, $: (s) => $(s, o) };
}
function confirmBox(title, html, okLabel = 'Confirm', danger = false) {
  return new Promise((resolve) => {
    const m = modal(title, `<div>${html}</div><div class="row end gap" style="margin-top:18px"><button class="btn" data-no type="button">Cancel</button><button class="btn ${danger ? 'danger' : 'primary'}" data-ok type="button">${esc(okLabel)}</button></div>`);
    let done = false;
    const fin = (v) => { if (!done) { done = true; resolve(v); } };
    $('[data-no]', m.el).onclick = () => { m.close(); fin(false); };
    $('[data-ok]', m.el).onclick = () => { m.close(); fin(true); };
    $('.x', m.el).addEventListener('click', () => fin(false));
    m.el.addEventListener('mousedown', (e) => { if (e.target === m.el) fin(false); });
  });
}
async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch { /* fall through */ }
  const ta = document.createElement('textarea');
  ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
  document.body.appendChild(ta); ta.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch { /* ignore */ }
  ta.remove();
  return ok;
}
const badge = (s) => {
  const map = { draft: ['', 'Draft'], scheduled: ['warn', 'Scheduled'], sending: ['acc', 'Sending'], paused: ['warn', 'Paused'], sent: ['ok', 'Sent'], failed: ['bad', 'Failed'],
    active: ['ok', 'Active'], error: ['bad', 'Needs attention'], disabled: ['', 'Disabled'], unsubscribed: ['warn', 'Unsubscribed'], bounced: ['bad', 'Bounced'], queued: ['', 'Queued'], skipped: ['', 'Skipped'] };
  const [cls, label] = map[s] || ['', s];
  return `<span class="badge ${cls}">${esc(label)}</span>`;
};

/* ---------- login and shell ---------- */
function logout() {
  state.token = null; store.del('mh_token');
  renderLogin();
}

function renderLogin(msg = '') {
  const pagesWarn = !API && /github\.io$/.test(location.hostname)
    ? '<p class="err-text">This dashboard is on GitHub Pages but API_BASE is empty. Set it in config.js to your server address.</p>' : '';
  $('#root').innerHTML = `<div class="login"><form class="card login-card" id="lf">
    <div class="brand big"><span class="logo">M</span> MailHub</div>
    <p class="mut" style="text-align:center;margin:10px 0 22px">Sign in to manage your newsletters.</p>
    <label>Email<input type="email" id="le" autocomplete="username" required></label>
    <label>Password<input type="password" id="lp" autocomplete="current-password" required></label>
    <div id="lerr" class="err-text" role="alert">${esc(msg)}</div>${pagesWarn}
    <button class="btn primary full" type="submit">Sign in</button>
    ${API ? `<p class="mut small" style="text-align:center;margin-bottom:0">Server: ${esc(API)}</p>` : ''}</form></div>`;
  $('#lf').onsubmit = async (e) => {
    e.preventDefault();
    try {
      const r = await post('/login', { email: $('#le').value, password: $('#lp').value });
      state.token = r.token; store.set('mh_token', r.token);
      await boot();
    } catch (err) { $('#lerr').textContent = err.message; }
  };
}

const ICONS = {
  overview: '<path d="M3 3h7v7H3zM14 3h7v4h-7zM14 10h7v11h-7zM3 13h7v8H3z"/>',
  campaigns: '<path d="M22 2 11 13M22 2l-7 20-4-9-9-4z"/>',
  contacts: '<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM23 21v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8"/>',
  companies: '<path d="M3 21h18M5 21V7l7-4 7 4v14M9 9h.01M9 13h.01M9 17h.01M15 9h.01M15 13h.01M15 17h.01"/>',
  mailboxes: '<path d="M4 4h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2zM22 6l-10 7L2 6"/>',
};
const NAV = [['overview', 'Overview'], ['campaigns', 'Campaigns'], ['contacts', 'Contacts'], ['companies', 'Companies & signatures'], ['mailboxes', 'Mailboxes']];

function renderShell() {
  $('#root').innerHTML = `<div class="app">
    <aside class="side"><div class="brand"><span class="logo">M</span> MailHub</div>
      <nav class="nav" id="nav">${NAV.map(([k, l]) => `<a href="#/${k}" data-k="${k}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICONS[k]}</svg>${esc(l)}</a>`).join('')}</nav>
      <div class="side-foot">Opens are approximate. Clicks are the most reliable signal.</div></aside>
    <div class="main"><header class="top"><div class="cosel"><label for="cosel">Company</label><select id="cosel"></select></div>
      <button class="btn ghost" id="logout" type="button">Sign out</button></header>
      <main id="view" class="view"></main></div></div>`;
  $('#logout').onclick = logout;
  $('#cosel').onchange = (e) => {
    state.cid = Number(e.target.value) || null; store.set('mh_cid', state.cid || '');
    route();
  };
  fillCompanySelect();
}
function fillCompanySelect() {
  const sel = $('#cosel');
  if (!sel) return;
  sel.innerHTML = state.companies.length
    ? state.companies.map((c) => `<option value="${c.id}"${c.id === state.cid ? ' selected' : ''}>${esc(c.name)}</option>`).join('')
    : '<option value="">No company yet</option>';
}
async function loadCompanies() {
  state.companies = await api('/companies');
  if (!state.companies.some((c) => c.id === state.cid)) state.cid = state.companies[0] ? state.companies[0].id : null;
  store.set('mh_cid', state.cid || '');
  fillCompanySelect();
}
function markNav(h) {
  const k = (h.match(/^#\/(\w+)/) || [])[1];
  $$('#nav a').forEach((a) => a.classList.toggle('on', a.dataset.k === k));
}
const noCompanyHtml = () => `<div class="card empty"><h3>Add your first company</h3><p>Every contact, mailbox, campaign and signature belongs to a company.</p>
  <a class="btn primary" href="#/companies">Add company</a></div>`;

/* ---------- router ---------- */
let routeId = 0;
const ROUTES = [
  [/^#\/overview$/, viewOverview],
  [/^#\/campaigns$/, viewCampaigns],
  [/^#\/campaigns\/new$/, (c) => viewEditor(c, null)],
  [/^#\/campaigns\/(\d+)\/edit$/, (c) => viewEditor(c, Number(c.m[1]))],
  [/^#\/campaigns\/(\d+)$/, viewReport],
  [/^#\/contacts$/, viewContacts],
  [/^#\/companies$/, viewCompanies],
  [/^#\/mailboxes$/, viewMailboxes],
];
async function route() {
  clearTimeout(timer);
  const my = ++routeId;
  const alive = () => my === routeId;
  const h = location.hash || '#/overview';
  markNav(h);
  const view = $('#view');
  if (!view) return;
  const hit = ROUTES.find(([re]) => re.test(h));
  if (!hit) { location.hash = '#/overview'; return; }
  if (!/^#\/companies/.test(h) && !state.cid) { view.innerHTML = noCompanyHtml(); return; }
  view.innerHTML = '<div class="loading">Loading…</div>';
  window.scrollTo(0, 0);
  try { await hit[1]({ m: h.match(hit[0]), alive, view }); }
  catch (e) { if (alive()) view.innerHTML = `<div class="card err">${esc(e.message)}</div>`; }
}

/* ---------- overview ---------- */
function chart(tl) {
  const W = 720, H = 180, pad = 8;
  const max = Math.max(1, ...tl.flatMap((d) => [d.sent, d.opens, d.clicks]));
  const bw = (W - pad * 2) / tl.length;
  const series = [['sent', 'var(--c1)'], ['opens', 'var(--c2)'], ['clicks', 'var(--c3)']];
  let s = `<svg class="chart" viewBox="0 0 ${W} ${H + 24}" role="img" aria-label="Sent, opened and clicked over the last 14 days">`;
  [0.25, 0.5, 0.75, 1].forEach((f) => { const y = H - f * H; s += `<line x1="${pad}" x2="${W - pad}" y1="${y}" y2="${y}"/>`; });
  tl.forEach((d, i) => {
    const x = pad + i * bw, w = (bw - 8) / 3;
    series.forEach(([k, col], j) => {
      const h = Math.round((d[k] / max) * H);
      s += `<rect x="${(x + 4 + j * w).toFixed(1)}" y="${H - h}" width="${(w - 1.5).toFixed(1)}" height="${h}" rx="2" fill="${col}"><title>${d.day}: ${num(d[k])} ${k}</title></rect>`;
    });
    if (i % 2 === 0) s += `<text x="${(x + bw / 2).toFixed(1)}" y="${H + 16}" text-anchor="middle">${d.day.slice(5)}</text>`;
  });
  return s + '</svg><div class="legend"><span><i style="background:var(--c1)"></i>Sent</span><span><i style="background:var(--c2)"></i>Opened</span><span><i style="background:var(--c3)"></i>Clicked</span></div>';
}

async function viewOverview(ctx) {
  const o = await api(qs('/overview'));
  const camps = await api(qs('/campaigns'));
  if (!ctx.alive()) return;
  const co = company();
  const steps = [
    ['Add company details and design your signature', !!(co && co.signature && co.signature.name), '#/companies', 'Open'],
    ['Connect a sending mailbox (SMTP)', o.mailboxes > 0, '#/mailboxes', 'Add'],
    ['Import contacts who agreed to receive your emails', o.active_contacts > 0, '#/contacts', 'Import'],
    ['Create and send your first campaign', o.campaigns > 0, '#/campaigns/new', 'Create'],
  ];
  const finished = steps.every((s) => s[1]);
  ctx.view.innerHTML = `<div class="page-head"><div><h1>Overview</h1><p>${esc(co.name)}: last 30 days</p></div>
    <a class="btn primary" href="#/campaigns/new">New campaign</a></div>
    <div class="grid kpis">
      <div class="kpi"><div class="l">Emails sent</div><div class="v">${num(o.sent_30d)}</div></div>
      <div class="kpi"><div class="l">Open rate</div><div class="v">${pct(o.opened_30d, o.sent_30d)}</div><div class="s">${num(o.opened_30d)} people</div></div>
      <div class="kpi"><div class="l">Click rate</div><div class="v">${pct(o.clicked_30d, o.sent_30d)}</div><div class="s">${num(o.clicked_30d)} people</div></div>
      <div class="kpi"><div class="l">Unsubscribed</div><div class="v">${num(o.unsubscribed_30d)}</div></div>
      <div class="kpi"><div class="l">Active contacts</div><div class="v">${num(o.active_contacts)}</div><div class="s">${num(o.suppressed)} suppressed</div></div>
    </div>
    ${finished ? '' : `<div class="card" style="margin-bottom:18px"><h3>Get started</h3><ul class="steps">${steps.map((s, i) =>
      `<li class="${s[1] ? 'done' : ''}"><span class="n">${s[1] ? '&#10003;' : i + 1}</span><span class="t">${esc(s[0])}</span>${s[1] ? '' : `<a href="${s[2]}">${s[3]} &rarr;</a>`}</li>`).join('')}</ul></div>`}
    <div class="card" style="margin-bottom:18px"><h3>Last 14 days</h3>${chart(o.timeline)}</div>
    <div class="card"><h3>Recent campaigns</h3>${camps.length ? campaignTable(camps.slice(0, 5)) : '<p class="mut">No campaigns yet.</p>'}</div>`;
  bindCampaignRows(ctx.view);
}

/* ---------- campaigns list ---------- */
function campaignTable(rows) {
  return `<div class="tablewrap"><table><thead><tr><th>Campaign</th><th>Status</th><th class="num">Sent</th><th class="num">Opened</th><th class="num">Clicked</th><th>Date</th></tr></thead><tbody>
    ${rows.map((c) => `<tr class="click" data-id="${c.id}" data-status="${c.status}"><td><b>${esc(c.name)}</b><div class="mut small">${esc(c.subject)}</div></td>
      <td>${badge(c.status)}</td><td class="num">${num(c.stats.sent)} / ${num(c.stats.total)}</td>
      <td class="num">${pct(c.stats.opened, c.stats.sent)}</td><td class="num">${pct(c.stats.clicked, c.stats.sent)}</td>
      <td>${esc(fdate(c.status === 'scheduled' ? c.scheduled_at : (c.started_at || c.created_at)))}</td></tr>`).join('')}</tbody></table></div>`;
}
function bindCampaignRows(root) {
  $$('tr.click', root).forEach((tr) => {
    tr.onclick = () => { location.hash = ['draft', 'scheduled'].includes(tr.dataset.status) ? `#/campaigns/${tr.dataset.id}/edit` : `#/campaigns/${tr.dataset.id}`; };
  });
}
async function viewCampaigns(ctx) {
  const rows = await api(qs('/campaigns'));
  if (!ctx.alive()) return;
  ctx.view.innerHTML = `<div class="page-head"><div><h1>Campaigns</h1><p>Write, schedule and track your newsletters.</p></div><a class="btn primary" href="#/campaigns/new">New campaign</a></div>
    ${rows.length ? campaignTable(rows) : '<div class="card empty"><h3>No campaigns yet</h3><p>Create your first newsletter. You can send yourself a test before anything goes out.</p><a class="btn primary" href="#/campaigns/new">New campaign</a></div>'}`;
  bindCampaignRows(ctx.view);
}

/* ---------- campaign editor ---------- */
const BTN = 'display:inline-block;background:#5b2a9a;color:#ffffff;padding:13px 26px;border-radius:8px;text-decoration:none;font-weight:bold';
const H2 = 'font-size:19px;margin:26px 0 6px;color:#1b1030';
const STARTERS = {
  newsletter: `<h1 style="margin:0 0 6px;font-size:26px;line-height:1.25;color:#1b1030">This week at {{company}}</h1>
<p style="color:#6b6480;margin:0 0 22px">Three minutes. One idea you can use today.</p>
<p>Hi {{first_name|there}},</p>
<p>Here is what is new and worth your time this week.</p>
<h2 style="${H2}">1. Your main insight</h2>
<p>Explain the idea in two or three short sentences. Be specific: use a number, an example or a result.</p>
<h2 style="${H2}">2. One quick tip</h2>
<p>Give the reader one thing they can do today.</p>
<p style="text-align:center;margin:30px 0"><a href="https://example.com" style="${BTN}">Read the full story</a></p>
<p>Hit reply and tell me what you want covered next. I read every message.</p>`,
  announce: `<p style="margin:0 0 6px;font-size:13px;letter-spacing:.1em;text-transform:uppercase;color:#5b2a9a;font-weight:bold">Announcement</p>
<h1 style="margin:0 0 14px;font-size:28px;line-height:1.2;color:#1b1030">Something new from {{company}}</h1>
<p>Hi {{first_name|there}},</p>
<p>We have something to share, and you are among the first to hear it.</p>
<ul style="padding-left:20px"><li>What is new</li><li>Why it matters to you</li><li>What to do next</li></ul>
<p style="text-align:center;margin:30px 0"><a href="https://example.com" style="${BTN}">See what is new</a></p>`,
  plain: `<p>Hi {{first_name|there}},</p>
<p>A short, personal note works well when you want replies.</p>
<p>Write two or three sentences, then ask one clear question at the end.</p>`,
};

async function viewEditor(ctx, id) {
  const [lists, mbs] = await Promise.all([api(qs('/lists')), api(qs('/mailboxes'))]);
  let c = id ? await api('/campaigns/' + id)
    : { name: '', subject: '', preheader: '', html: STARTERS.newsletter, list_id: lists[0] ? lists[0].id : null, mailbox_ids: mbs.filter((m) => m.status === 'active').slice(0, 1).map((m) => m.id), status: 'draft' };
  if (!ctx.alive()) return;
  if (id && !['draft', 'scheduled'].includes(c.status)) { location.hash = '#/campaigns/' + id; return; }
  const locked = c.status === 'scheduled';

  ctx.view.innerHTML = `<div class="page-head"><div><h1>${id ? 'Edit campaign' : 'New campaign'}</h1>
      ${locked ? `<p>${badge('scheduled')} Scheduled for ${esc(fdate(c.scheduled_at))}. Cancel the schedule to change anything.</p>` : '<p>Your company signature and an unsubscribe footer are added automatically.</p>'}</div>
    <div class="row gap wrap">${locked ? '<button class="btn" id="unsch" type="button">Cancel schedule</button>' : '<button class="btn" id="save" type="button">Save draft</button><button class="btn primary" id="send" type="button">Schedule or send…</button>'}</div></div>
    <div class="editor"><div class="card"><fieldset ${locked ? 'disabled' : ''} style="border:0;padding:0;margin:0">
      <label>Campaign name <small>(only you see this)</small><input id="f-name" maxlength="120"></label>
      <label>Subject line<input id="f-subject" maxlength="200" placeholder="Hi {{first_name|friend}}, this week's idea"></label>
      <label>Preview text <small>(shown next to the subject in the inbox)</small><input id="f-pre" maxlength="200"></label>
      <label>Send to list<select id="f-list">${lists.length ? lists.map((l) => `<option value="${l.id}">${esc(l.name)} (${num(l.active_count)} active)</option>`).join('') : '<option value="">No lists yet. Import contacts first.</option>'}</select></label>
      <fieldset><legend>Send from</legend>${mbs.length ? mbs.map((m) => `<label class="check"><input type="checkbox" name="mb" value="${m.id}" ${m.status !== 'active' ? 'disabled' : ''}>
        <span>${esc(m.label)} <span class="mut small">${esc(m.from_email)} &middot; ${num(Math.max(0, m.effective_limit - m.sent_today))} left today${m.status !== 'active' ? ' &middot; needs attention' : ''}</span></span></label>`).join('')
        : '<p class="mut" style="margin:0">No mailbox yet. <a href="#/mailboxes">Add one</a>.</p>'}
        <p class="hint">Select several to share the sending between mailboxes.</p></fieldset>
      <label>Email content <small>(HTML)</small></label>
      <div class="starters">Start from: <button class="btn sm" type="button" data-st="newsletter">Newsletter</button><button class="btn sm" type="button" data-st="announce">Announcement</button><button class="btn sm" type="button" data-st="plain">Short note</button></div>
      <textarea id="f-html" rows="16" spellcheck="false"></textarea>
      <p class="hint">Personalise with <code>{{first_name}}</code>, <code>{{first_name|there}}</code> (fallback), <code>{{last_name}}</code>, <code>{{email}}</code>, <code>{{company}}</code>. Links are tracked automatically.</p>
      </fieldset>
      ${id ? `<label style="margin-top:16px">Send a test email<div class="test-row"><input id="t-to" type="email" placeholder="you@yourcompany.com"><button class="btn" id="t-send" type="button">Send test</button></div></label>` : '<p class="hint" style="margin-top:14px">Save the draft once to unlock test emails.</p>'}
    </div>
    <div class="card sticky"><div class="prev-head">Live preview <span>with signature and footer</span></div><iframe class="prev" id="prev" sandbox title="Email preview"></iframe></div></div>`;

  $('#f-name').value = c.name; $('#f-subject').value = c.subject; $('#f-pre').value = c.preheader || ''; $('#f-html').value = c.html;
  if (c.list_id && $('#f-list')) $('#f-list').value = c.list_id;
  $$('input[name=mb]').forEach((cb) => { cb.checked = c.mailbox_ids.includes(Number(cb.value)); });

  const selected = () => $$('input[name=mb]:checked').map((cb) => Number(cb.value));
  const read = () => ({ company_id: state.cid, name: $('#f-name').value.trim() || 'Untitled campaign', subject: $('#f-subject').value.trim(), preheader: $('#f-pre').value.trim(), html: $('#f-html').value, list_id: Number($('#f-list').value) || null, mailbox_ids: selected() });
  const refresh = debounce(async () => {
    try {
      const b = read();
      const r = await post('/campaigns/preview', { company_id: state.cid, subject: b.subject, preheader: b.preheader, html: b.html, mailbox_id: b.mailbox_ids[0] });
      if (ctx.alive() && $('#prev')) $('#prev').srcdoc = r.html;
    } catch { /* preview is best effort */ }
  }, 350);
  ['f-subject', 'f-pre', 'f-html'].forEach((i) => $('#' + i).addEventListener('input', refresh));
  $$('input[name=mb]').forEach((cb) => cb.addEventListener('change', refresh));
  refresh();

  $$('[data-st]').forEach((b) => { b.onclick = async () => {
    if ($('#f-html').value.trim() && !(await confirmBox('Replace content?', '<p>This replaces what you have written in the content box.</p>', 'Replace'))) return;
    $('#f-html').value = STARTERS[b.dataset.st]; refresh();
  }; });

  async function save() {
    const body = read();
    if (id) { c = await put('/campaigns/' + id, body); return id; }
    const r = await post('/campaigns', body);
    id = r.id; history.replaceState(null, '', '#/campaigns/' + id + '/edit');
    return id;
  }
  if ($('#save')) $('#save').onclick = async () => { try { await save(); toast('Draft saved'); if (!$('#t-to')) route(); } catch (e) { toast(e.message, 'bad'); } };
  if ($('#unsch')) $('#unsch').onclick = async () => { await post(`/campaigns/${id}/unschedule`); toast('Schedule cancelled'); route(); };
  if ($('#t-send')) $('#t-send').onclick = async () => {
    const mbIds = selected();
    if (!mbIds.length) return toast('Select a mailbox to send the test from.', 'bad');
    try {
      await save();
      const r = await post(`/campaigns/${id}/test`, { to: $('#t-to').value, mailbox_id: mbIds[0] });
      r.ok ? toast('Test email sent. Check your inbox (and spam).') : toast('Test failed: ' + r.error, 'bad');
    } catch (e) { toast(e.message, 'bad'); }
  };
  if ($('#send')) $('#send').onclick = async () => {
    try {
      const b = read();
      if (!b.subject) throw new Error('Add a subject line first.');
      if (!b.list_id) throw new Error('Choose a list to send to.');
      if (!b.mailbox_ids.length) throw new Error('Select at least one mailbox.');
      await save();
      const list = lists.find((l) => l.id === b.list_id);
      const chosen = mbs.filter((m) => b.mailbox_ids.includes(m.id));
      const room = chosen.reduce((a, m) => a + Math.max(0, m.effective_limit - m.sent_today), 0);
      const perDay = chosen.reduce((a, m) => a + m.effective_limit, 0);
      const people = list ? list.active_count : 0;
      const days = perDay ? Math.ceil(Math.max(0, people - room) / perDay) : 0;
      const m = modal('Send this campaign', `<p><b>${num(people)}</b> active contacts in <b>${esc(list ? list.name : '')}</b>.</p>
        <p class="mut" style="margin-top:0">Your selected mailboxes can send about ${num(room)} more today${days ? `, so the rest continues over the next ${days} day${days > 1 ? 's' : ''}` : ''}. Sending slowly protects your domain reputation.</p>
        <label class="check"><input type="radio" name="when" value="now" checked>Start now</label>
        <label class="check"><input type="radio" name="when" value="later">Schedule for later</label>
        <input type="datetime-local" id="when-at" style="margin-bottom:16px" disabled>
        <div class="row end gap"><button class="btn" data-no type="button">Cancel</button><button class="btn primary" data-go type="button">Confirm</button></div>`);
      $$('input[name=when]', m.el).forEach((r) => r.onchange = () => { $('#when-at', m.el).disabled = r.value !== 'later' || !r.checked; });
      $('[data-no]', m.el).onclick = m.close;
      $('[data-go]', m.el).onclick = async () => {
        const later = $('input[name=when]:checked', m.el).value === 'later';
        const v = $('#when-at', m.el).value;
        if (later && !v) return toast('Pick a date and time.', 'bad');
        try {
          await post(`/campaigns/${id}/schedule`, { at: later ? new Date(v).toISOString() : null });
          m.close(); toast(later ? 'Campaign scheduled' : 'Sending started');
          location.hash = later ? '#/campaigns' : '#/campaigns/' + id;
        } catch (e) { toast(e.message, 'bad'); }
      };
    } catch (e) { toast(e.message, 'bad'); }
  };
}

/* ---------- campaign report ---------- */
async function viewReport(ctx) {
  const id = Number(ctx.m[1]);
  let filter = 'all', off = 0;
  const FILTERS = [['all', 'Everyone'], ['opened', 'Opened'], ['clicked', 'Clicked'], ['unsubscribed', 'Unsubscribed'], ['failed', 'Failed'], ['queued', 'Waiting']];

  async function paint() {
    const [d, rec] = await Promise.all([api(`/campaigns/${id}/stats`), api(`/campaigns/${id}/recipients?filter=${filter}&offset=${off}&limit=50`)]);
    if (!ctx.alive()) return;
    const c = d.campaign, s = d.stats;
    const progress = s.total ? Math.round(((s.sent + s.failed + s.skipped) / s.total) * 100) : 0;
    ctx.view.innerHTML = `<div class="page-head"><div><h1>${esc(c.name)}</h1><p>${badge(c.status)} &nbsp;${esc(c.subject)}</p></div>
      <div class="row gap wrap"><a class="btn" href="#/campaigns">&larr; All campaigns</a>
      ${c.status === 'sending' ? '<button class="btn" id="pause" type="button">Pause</button>' : ''}${c.status === 'paused' ? '<button class="btn primary" id="resume" type="button">Resume</button>' : ''}
      <button class="btn" id="dup" type="button">Duplicate</button><button class="btn danger" id="rm" type="button">Delete</button></div></div>
      ${c.note ? `<div class="card err" style="margin-bottom:14px">${esc(c.note)}</div>` : ''}
      <div class="card" style="margin-bottom:14px"><div class="row between" style="margin-bottom:8px"><b>Delivery</b><span class="mut">${num(s.sent)} of ${num(s.total)} sent${s.queued ? ` &middot; ${num(s.queued)} waiting` : ''}</span></div>
      <div class="bar"><i style="width:${progress}%"></i></div>
      ${c.status === 'sending' && s.queued ? '<p class="hint">Emails go out slowly, one at a time per mailbox. If a mailbox reaches its daily limit, sending continues the next day.</p>' : ''}</div>
      <div class="grid kpis">
        <div class="kpi"><div class="l">Opened</div><div class="v">${pct(s.opened, s.sent)}</div><div class="s">${num(s.opened)} people</div></div>
        <div class="kpi"><div class="l">Clicked</div><div class="v">${pct(s.clicked, s.sent)}</div><div class="s">${num(s.clicked)} people &middot; ${num(s.total_clicks)} clicks</div></div>
        <div class="kpi"><div class="l">Unsubscribed</div><div class="v">${num(s.unsubscribed)}</div></div>
        <div class="kpi"><div class="l">Failed</div><div class="v">${num(s.failed)}</div></div>
      </div>
      <div class="grid cols2" style="margin-bottom:18px">
        <div class="card"><h3>Top links</h3>${d.links.length ? `<div class="tablewrap"><table><thead><tr><th>Link</th><th class="num">People</th><th class="num">Clicks</th></tr></thead><tbody>${d.links.map((l) => `<tr><td style="word-break:break-all">${esc(l.url)}</td><td class="num">${num(l.unique_clicks)}</td><td class="num">${num(l.clicks)}</td></tr>`).join('')}</tbody></table></div>` : '<p class="mut">No clicks yet.</p>'}</div>
        <div class="card"><h3>Activity by hour</h3>${d.timeline.length ? hourBars(d.timeline) : '<p class="mut">Nothing yet. Opens and clicks appear here as people read.</p>'}</div>
      </div>
      <div class="card"><h3>Recipients</h3>
      <div class="tabs">${FILTERS.map(([k, l]) => `<button class="tab ${k === filter ? 'on' : ''}" data-f="${k}" type="button">${l}</button>`).join('')}</div>
      ${rec.rows.length ? `<div class="tablewrap"><table><thead><tr><th>Email</th><th>Status</th><th>Sent</th><th class="num">Opens</th><th class="num">Clicks</th></tr></thead><tbody>
        ${rec.rows.map((r) => `<tr><td>${esc(r.email)}${r.first_name ? ` <span class="mut small">${esc(r.first_name)}</span>` : ''}</td><td>${badge(r.unsubs ? 'unsubscribed' : r.status)}${r.error ? `<div class="mut small">${esc(r.error)}</div>` : ''}</td><td>${esc(fdate(r.sent_at))}</td><td class="num">${num(r.opens)}</td><td class="num">${num(r.clicks)}</td></tr>`).join('')}</tbody></table></div>
        <div class="row between" style="margin-top:12px"><span class="mut small">${num(off + 1)}–${num(off + rec.rows.length)} of ${num(rec.total)}</span><span class="row gap"><button class="btn sm" id="pv" type="button" ${off ? '' : 'disabled'}>Previous</button><button class="btn sm" id="nx" type="button" ${off + 50 < rec.total ? '' : 'disabled'}>Next</button></span></div>`
        : '<p class="mut">Nobody in this view yet.</p>'}
      ${s.bot_events ? `<p class="hint">${num(s.bot_events)} automatic hits from security scanners were ignored.</p>` : ''}
      <p class="hint">Open tracking is approximate: some apps load images automatically, others block them. Clicks are the more reliable signal.</p></div>`;

    $$('[data-f]').forEach((b) => { b.onclick = () => { filter = b.dataset.f; off = 0; paint(); }; });
    if ($('#pv')) $('#pv').onclick = () => { off = Math.max(0, off - 50); paint(); };
    if ($('#nx')) $('#nx').onclick = () => { off += 50; paint(); };
    if ($('#pause')) $('#pause').onclick = async () => { await post(`/campaigns/${id}/pause`); paint(); };
    if ($('#resume')) $('#resume').onclick = async () => { await post(`/campaigns/${id}/resume`); paint(); };
    $('#dup').onclick = async () => {
      const full = await api('/campaigns/' + id);
      const n = await post('/campaigns', { company_id: state.cid, name: c.name + ' (copy)', subject: full.subject, preheader: full.preheader, html: full.html, list_id: full.list_id, mailbox_ids: full.mailbox_ids });
      location.hash = `#/campaigns/${n.id}/edit`;
    };
    $('#rm').onclick = async () => {
      if (!(await confirmBox('Delete campaign?', '<p>The campaign and its tracking history will be deleted. People who unsubscribed stay unsubscribed.</p>', 'Delete', true))) return;
      try { await del('/campaigns/' + id); toast('Campaign deleted'); location.hash = '#/campaigns'; } catch (e) { toast(e.message, 'bad'); }
    };
    if (['sending', 'scheduled'].includes(c.status)) timer = setTimeout(() => ctx.alive() && paint().catch(() => {}), 5000);
  }
  await paint();
}
function hourBars(tl) {
  const W = 520, H = 120;
  const max = Math.max(1, ...tl.flatMap((d) => [d.opens, d.clicks]));
  const bw = W / tl.length;
  let s = `<svg class="chart" viewBox="0 0 ${W} ${H + 20}" role="img" aria-label="Opens and clicks by hour">`;
  tl.forEach((d, i) => {
    const w = Math.max(2, bw / 2 - 1.5);
    [['opens', 'var(--c2)'], ['clicks', 'var(--c3)']].forEach(([k, col], j) => {
      const h = Math.round((d[k] / max) * H);
      s += `<rect x="${(i * bw + 1 + j * w).toFixed(1)}" y="${H - h}" width="${w.toFixed(1)}" height="${h}" rx="1.5" fill="${col}"><title>${d.hour.replace('T', ' ')}:00 ${k}: ${d[k]}</title></rect>`;
    });
  });
  s += `<text x="0" y="${H + 14}">${esc(tl[0].hour.slice(5).replace('T', ' '))}h</text><text x="${W}" y="${H + 14}" text-anchor="end">${esc(tl[tl.length - 1].hour.slice(5).replace('T', ' '))}h</text></svg>`;
  return s + '<div class="legend"><span><i style="background:var(--c2)"></i>Opened</span><span><i style="background:var(--c3)"></i>Clicked</span></div>';
}

/* ---------- contacts ---------- */
function parseCsv(text) {
  text = text.replace(/^﻿/, '');
  const first = text.split(/\r?\n/)[0] || '';
  const delim = first.includes('\t') ? '\t' : first.includes(';') && !first.includes(',') ? ';' : ',';
  const rows = []; let row = [], cur = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) { if (ch === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += ch; }
    else if (ch === '"') q = true;
    else if (ch === delim) { row.push(cur); cur = ''; }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && text[i + 1] === '\n') i++; row.push(cur); cur = ''; if (row.some((x) => x.trim())) rows.push(row); row = []; }
    else cur += ch;
  }
  row.push(cur); if (row.some((x) => x.trim())) rows.push(row);
  if (!rows.length) return [];
  const head = rows[0].map((h) => h.trim().toLowerCase().replace(/[\s-]+/g, '_'));
  const hasHeader = head.some((h) => /^e_?mail/.test(h));
  const idx = (names) => head.findIndex((h) => names.includes(h));
  const iE = hasHeader ? head.findIndex((h) => /^e_?mail/.test(h)) : 0;
  const iF = hasHeader ? idx(['first_name', 'firstname', 'first', 'name', 'given_name']) : 1;
  const iL = hasHeader ? idx(['last_name', 'lastname', 'last', 'surname', 'family_name']) : 2;
  return (hasHeader ? rows.slice(1) : rows).map((r) => ({ email: (r[iE] || '').trim(), first_name: iF >= 0 ? (r[iF] || '').trim() : '', last_name: iL >= 0 ? (r[iL] || '').trim() : '' }));
}

async function viewContacts(ctx) {
  let lists = await api(qs('/lists'));
  let listId = '', status = '', q = '', off = 0;
  const LIMIT = 50;

  async function paint() {
    const url = qs(`/contacts?limit=${LIMIT}&offset=${off}${listId ? '&list_id=' + listId : ''}${status ? '&status=' + status : ''}${q ? '&q=' + encodeURIComponent(q) : ''}`);
    const d = await api(url);
    if (!ctx.alive()) return;
    ctx.view.innerHTML = `<div class="page-head"><div><h1>Contacts</h1><p>Only add people who agreed to hear from you. Unsubscribed and bounced people are never emailed again.</p></div>
      <div class="row gap wrap"><button class="btn" id="newlist" type="button">New list</button><button class="btn primary" id="imp" type="button">Import contacts</button></div></div>
      <div class="row gap wrap" style="margin-bottom:14px">
        <select id="fl" style="width:auto;margin:0"><option value="">All lists</option>${lists.map((l) => `<option value="${l.id}" ${String(l.id) === String(listId) ? 'selected' : ''}>${esc(l.name)} (${num(l.total)})</option>`).join('')}</select>
        <select id="fs" style="width:auto;margin:0">${[['', 'Any status'], ['active', 'Active'], ['unsubscribed', 'Unsubscribed'], ['bounced', 'Bounced']].map(([v, l]) => `<option value="${v}" ${v === status ? 'selected' : ''}>${l}</option>`).join('')}</select>
        <input id="fq" placeholder="Search email or name" value="${esc(q)}" style="width:240px;margin:0">
        ${listId ? '<button class="btn danger sm" id="rmlist" type="button">Delete this list</button>' : ''}</div>
      ${d.rows.length ? `<div class="tablewrap"><table><thead><tr><th>Email</th><th>Name</th><th>Status</th><th>Consent</th><th></th></tr></thead><tbody>
        ${d.rows.map((r) => `<tr><td>${esc(r.email)}</td><td>${esc([r.first_name, r.last_name].filter(Boolean).join(' '))}</td><td>${badge(r.status)}</td>
          <td class="mut small">${esc(r.consent_source)}<div>${esc(fdate(r.consent_at))}</div></td>
          <td class="num">${r.status === 'active' ? `<button class="btn sm" data-unsub="${r.id}" type="button">Unsubscribe</button> <button class="btn sm danger" data-del="${r.id}" type="button">Delete</button>` : ''}</td></tr>`).join('')}</tbody></table></div>
        <div class="row between" style="margin-top:12px"><span class="mut small">${num(off + 1)}–${num(off + d.rows.length)} of ${num(d.total)}</span><span class="row gap"><button class="btn sm" id="pv" type="button" ${off ? '' : 'disabled'}>Previous</button><button class="btn sm" id="nx" type="button" ${off + LIMIT < d.total ? '' : 'disabled'}>Next</button></span></div>`
        : '<div class="card empty"><h3>No contacts here</h3><p>Import a CSV file or paste emails to build your list.</p></div>'}`;

    $('#fl').onchange = (e) => { listId = e.target.value; off = 0; paint(); };
    $('#fs').onchange = (e) => { status = e.target.value; off = 0; paint(); };
    $('#fq').oninput = debounce((e) => { q = e.target.value.trim(); off = 0; paint().then(() => { const el = $('#fq'); if (el) { el.focus(); el.setSelectionRange(q.length, q.length); } }); }, 400);
    if ($('#pv')) $('#pv').onclick = () => { off = Math.max(0, off - LIMIT); paint(); };
    if ($('#nx')) $('#nx').onclick = () => { off += LIMIT; paint(); };
    $('#imp').onclick = () => importModal(lists, listId, async () => { lists = await api(qs('/lists')); paint(); });
    $('#newlist').onclick = async () => {
      const m = modal('New list', '<label>List name<input id="ln" maxlength="80" placeholder="e.g. Newsletter subscribers"></label><div class="row end"><button class="btn primary" id="lc" type="button">Create</button></div>');
      m.$('#lc').onclick = async () => { try { await post('/lists', { company_id: state.cid, name: m.$('#ln').value }); m.close(); lists = await api(qs('/lists')); paint(); } catch (e) { toast(e.message, 'bad'); } };
    };
    if ($('#rmlist')) $('#rmlist').onclick = async () => {
      if (!(await confirmBox('Delete list?', '<p>The list is removed. The contacts stay in your account.</p>', 'Delete list', true))) return;
      await del('/lists/' + listId); listId = ''; lists = await api(qs('/lists')); paint();
    };
    $$('[data-unsub]').forEach((b) => { b.onclick = async () => { await post(`/contacts/${b.dataset.unsub}/unsubscribe`); paint(); }; });
    $$('[data-del]').forEach((b) => { b.onclick = async () => {
      if (!(await confirmBox('Delete contact?', '<p>This removes the contact and their history.</p>', 'Delete', true))) return;
      try { await del('/contacts/' + b.dataset.del); paint(); } catch (e) { toast(e.message, 'bad'); }
    }; });
  }
  await paint();
}

function importModal(lists, listId, done) {
  const m = modal('Import contacts', `<label>Paste emails or CSV <small>(email, first_name, last_name. One person per line)</small>
    <textarea id="im-text" rows="7" placeholder="email,first_name,last_name&#10;ana@example.com,Ana,Khan"></textarea></label>
    <label>…or choose a CSV file<input type="file" id="im-file" accept=".csv,.txt,text/csv"></label>
    <div class="two"><label>Add to list<select id="im-list">${lists.map((l) => `<option value="${l.id}" ${String(l.id) === String(listId) ? 'selected' : ''}>${esc(l.name)}</option>`).join('')}<option value="">+ New list…</option></select></label>
    <label id="im-newwrap" ${lists.length ? 'hidden' : ''}>New list name<input id="im-new" value="Main list" maxlength="80"></label></div>
    <label>Where did these people agree to hear from you?<select id="im-src"><option>Website signup form</option><option>Existing customers who opted in</option><option>Event or meeting opt-in</option><option>Other (opt-in)</option></select></label>
    <label class="check"><input type="checkbox" id="im-ok">I confirm these people agreed to receive emails from this company.</label>
    <p class="hint" id="im-count"></p><div class="err-text" id="im-err"></div>
    <div class="row end gap"><button class="btn" data-no type="button">Cancel</button><button class="btn primary" id="im-go" type="button">Import</button></div>`, { wide: false });
  const sync = () => { m.$('#im-newwrap').hidden = m.$('#im-list').value !== ''; };
  m.$('#im-list').onchange = sync; sync();
  const count = () => { const n = parseCsv(m.$('#im-text').value).length; m.$('#im-count').textContent = n ? `${num(n)} row${n > 1 ? 's' : ''} found.` : ''; };
  m.$('#im-text').oninput = count;
  m.$('#im-file').onchange = (e) => { const f = e.target.files[0]; if (!f) return; const r = new FileReader(); r.onload = () => { m.$('#im-text').value = String(r.result); count(); }; r.readAsText(f); };
  m.$('[data-no]').onclick = m.close;
  m.$('#im-go').onclick = async () => {
    const rows = parseCsv(m.$('#im-text').value);
    if (!rows.length) { m.$('#im-err').textContent = 'Paste some emails or choose a file first.'; return; }
    if (!m.$('#im-ok').checked) { m.$('#im-err').textContent = 'Please confirm that these people agreed to receive emails.'; return; }
    const btn = m.$('#im-go'); btn.disabled = true;
    try {
      const lid = m.$('#im-list').value;
      const r = await post('/contacts/import', { company_id: state.cid, list_id: lid ? Number(lid) : null, list_name: m.$('#im-new').value, consent_source: m.$('#im-src').value, confirmed: true, rows });
      m.close();
      toast(`${num(r.added)} added, ${num(r.updated)} updated` + (r.invalid ? `, ${num(r.invalid)} invalid` : '') + (r.suppressed ? `, ${num(r.suppressed)} skipped (unsubscribed or bounced)` : '') + (r.duplicates ? `, ${num(r.duplicates)} duplicates` : ''));
      done();
    } catch (e) { m.$('#im-err').textContent = e.message; btn.disabled = false; }
  };
}

/* ---------- companies and signature designer ---------- */
async function viewCompanies(ctx) {
  await loadCompanies();
  if (!ctx.alive()) return;
  ctx.view.innerHTML = `<div class="page-head"><div><h1>Companies &amp; signatures</h1><p>Each company has its own contacts, mailboxes, campaigns and email signature.</p></div>
    <button class="btn primary" id="addco" type="button">Add company</button></div>
    ${state.companies.length ? `<div class="grid cols2">${state.companies.map((c) => `<div class="card">
      <div class="row between"><h2><span class="dot" style="background:${esc(c.brand_color)}"></span>${esc(c.name)}</h2>${c.id === state.cid ? '<span class="badge acc">Selected</span>' : ''}</div>
      <p class="mut" style="margin:6px 0 14px">${esc(c.website || 'No website yet')}</p>
      <div class="row gap wrap mut small" style="margin-bottom:14px"><span>${num(c.contacts)} contacts</span><span>&middot;</span><span>${num(c.campaigns)} campaigns</span><span>&middot;</span><span>${num(c.mailboxes)} mailboxes</span></div>
      <div class="row gap wrap"><button class="btn sm" data-edit="${c.id}" type="button">Edit &amp; design signature</button><button class="btn sm" data-sel="${c.id}" type="button">Select</button><button class="btn sm danger" data-rm="${c.id}" type="button">Delete</button></div></div>`).join('')}</div>`
      : '<div class="card empty"><h3>No companies yet</h3><p>Add the first company you will send newsletters for.</p></div>'}`;
  $('#addco').onclick = () => companyModal(null);
  $$('[data-edit]').forEach((b) => { b.onclick = () => companyModal(state.companies.find((c) => c.id === Number(b.dataset.edit))); });
  $$('[data-sel]').forEach((b) => { b.onclick = () => { state.cid = Number(b.dataset.sel); store.set('mh_cid', state.cid); fillCompanySelect(); route(); }; });
  $$('[data-rm]').forEach((b) => { b.onclick = async () => {
    const c = state.companies.find((x) => x.id === Number(b.dataset.rm));
    if (!(await confirmBox('Delete company?', `<p>This permanently deletes <b>${esc(c.name)}</b> with all its contacts, mailboxes, campaigns and tracking history.</p>`, 'Delete everything', true))) return;
    await del('/companies/' + c.id); await loadCompanies(); route();
  }; });
}

function companyModal(co) {
  const sig = { template: 'classic', socials: {}, ...(co && co.signature ? co.signature : {}) };
  sig.socials = sig.socials || {};
  let tpl = sig.template;
  let lastHtml = '';
  const SOCIALS = [['linkedin', 'LinkedIn'], ['x', 'X (Twitter)'], ['instagram', 'Instagram'], ['facebook', 'Facebook'], ['youtube', 'YouTube']];
  const m = modal(co ? 'Edit ' + co.name : 'Add company', `<div class="sigwrap"><div>
    <h3>Company</h3>
    <label>Company name<input id="c-name" maxlength="120"></label>
    <div class="two"><label>Website<input id="c-web" placeholder="https://company.com"></label><label>Brand colour<input type="color" id="c-color"></label></div>
    <label>Logo URL <small>(a public image link, PNG or JPG, about 300 px wide)</small><input id="c-logo" placeholder="https://company.com/logo.png"></label>
    <label>Postal address <small>(shown in the email footer)</small><input id="c-addr" maxlength="300"></label>
    <h3 style="margin-top:20px">Signature</h3>
    <div class="tpls">${[['classic', 'Classic'], ['modern', 'Modern'], ['minimal', 'Minimal']].map(([k, l]) => `<button type="button" class="tpl ${k === tpl ? 'on' : ''}" data-t="${k}">${l}</button>`).join('')}</div>
    <div class="two"><label>Name<input id="s-name" maxlength="100"></label><label>Job title<input id="s-title" maxlength="100"></label></div>
    <div class="two"><label>Phone<input id="s-phone" maxlength="40"></label><label>Email<input id="s-email" maxlength="120"></label></div>
    <label>Tagline <small>(optional)</small><input id="s-tag" maxlength="160"></label>
    <div class="two">${SOCIALS.map(([k, l]) => `<label>${l}<input id="s-${k}" placeholder="link"></label>`).join('')}</div>
    <p class="hint">A mailbox can override name, title and phone, so every sender gets a personal signature in the company design.</p>
    </div><div><div class="sticky" style="top:16px"><h3>Preview</h3><div class="sigprev" id="sigprev"></div>
    <div class="row gap" style="margin-top:12px"><button class="btn" id="copysig" type="button">Copy signature HTML</button></div>
    <p class="hint">Use "Copy signature HTML" to paste the same design into Gmail, Outlook or Hostinger webmail.</p></div></div></div>
    <div class="err-text" id="c-err" style="margin-top:12px"></div>
    <div class="row end gap"><button class="btn" data-no type="button">Cancel</button><button class="btn primary" id="c-save" type="button">Save company</button></div>`, { wide: true });

  const set = (id, v) => { m.$('#' + id).value = v || ''; };
  set('c-name', co && co.name); set('c-web', co && co.website); set('c-logo', co && co.logo_url); set('c-addr', co && co.address);
  m.$('#c-color').value = (co && co.brand_color) || '#4B2A8A';
  set('s-name', sig.name); set('s-title', sig.title); set('s-phone', sig.phone); set('s-email', sig.email); set('s-tag', sig.tagline);
  SOCIALS.forEach(([k]) => set('s-' + k, sig.socials[k]));

  const read = () => {
    const g = (id) => m.$('#' + id).value.trim();
    return { name: g('c-name'), website: g('c-web'), logo_url: g('c-logo'), brand_color: m.$('#c-color').value, address: g('c-addr'),
      signature: { template: tpl, name: g('s-name'), title: g('s-title'), phone: g('s-phone'), email: g('s-email'), tagline: g('s-tag'),
        socials: Object.fromEntries(SOCIALS.map(([k]) => [k, g('s-' + k)]).filter(([, v]) => v)) } };
  };
  const preview = debounce(async () => {
    try {
      const b = read();
      const r = await post('/signature/preview', { company: { name: b.name, website: b.website, logo_url: b.logo_url, brand_color: b.brand_color }, signature: b.signature });
      lastHtml = r.html; m.$('#sigprev').innerHTML = r.html;
    } catch { /* ignore */ }
  }, 300);
  m.el.addEventListener('input', preview);
  $$('[data-t]', m.el).forEach((b) => { b.onclick = () => { tpl = b.dataset.t; $$('[data-t]', m.el).forEach((x) => x.classList.toggle('on', x === b)); preview(); }; });
  preview();
  m.$('#copysig').onclick = async () => { toast((await copyText(lastHtml)) ? 'Signature HTML copied' : 'Could not copy. Select the preview and copy it by hand.', 'ok'); };
  m.$('[data-no]').onclick = m.close;
  m.$('#c-save').onclick = async () => {
    const b = read();
    if (!b.name) { m.$('#c-err').textContent = 'Company name is required.'; return; }
    try {
      const saved = co ? await put('/companies/' + co.id, b) : await post('/companies', b);
      if (!co) { state.cid = saved.id; store.set('mh_cid', saved.id); }
      m.close(); await loadCompanies(); toast('Company saved'); route();
    } catch (e) { m.$('#c-err').textContent = e.message; }
  };
}

/* ---------- mailboxes ---------- */
const PRESETS = {
  hostinger: { label: 'Hostinger Email', host: 'smtp.hostinger.com', port: 465, secure: true },
  google: { label: 'Google Workspace', host: 'smtp.gmail.com', port: 465, secure: true },
  microsoft: { label: 'Microsoft 365', host: 'smtp.office365.com', port: 587, secure: false },
  zoho: { label: 'Zoho Mail', host: 'smtp.zoho.com', port: 465, secure: true },
  custom: { label: 'Other / cPanel / own server', host: '', port: 587, secure: false },
};

async function viewMailboxes(ctx) {
  const rows = await api(qs('/mailboxes'));
  if (!ctx.alive()) return;
  ctx.view.innerHTML = `<div class="page-head"><div><h1>Mailboxes</h1><p>The company email accounts MailHub sends from, using your host's SMTP server.</p></div>
    <button class="btn primary" id="addmb" type="button">Add mailbox</button></div>
    ${rows.length ? `<div class="tablewrap"><table><thead><tr><th>Mailbox</th><th>SMTP server</th><th class="num">Sent today</th><th>Status</th><th></th></tr></thead><tbody>
      ${rows.map((r) => `<tr><td><b>${esc(r.label)}</b><div class="mut small">${esc(r.from_name)} &lt;${esc(r.from_email)}&gt;</div></td>
        <td class="mut small">${esc(r.host)}:${r.port} ${r.secure ? '(SSL)' : '(STARTTLS)'}</td>
        <td class="num">${num(r.sent_today)} / ${num(r.effective_limit)}${r.ramp_up && r.effective_limit < r.daily_limit ? `<div class="mut small">warming up to ${num(r.daily_limit)}</div>` : ''}</td>
        <td>${badge(r.status)}${r.last_error ? `<div class="mut small" style="max-width:260px">${esc(r.last_error)}</div>` : ''}</td>
        <td class="num"><button class="btn sm" data-test="${r.id}" type="button">Test</button> <button class="btn sm" data-edit="${r.id}" type="button">Edit</button> <button class="btn sm danger" data-rm="${r.id}" type="button">Delete</button></td></tr>`).join('')}</tbody></table></div>
      <p class="hint">Daily limits protect your reputation. New mailboxes start low and grow every day when "warm-up" is on.</p>`
      : '<div class="card empty"><h3>No mailbox yet</h3><p>Add the company email account you want to send from. You need its SMTP details from your email host.</p></div>'}`;
  $('#addmb').onclick = () => mailboxModal(null);
  $$('[data-edit]').forEach((b) => { b.onclick = () => mailboxModal(rows.find((r) => r.id === Number(b.dataset.edit))); });
  $$('[data-test]').forEach((b) => { b.onclick = async () => {
    b.disabled = true; b.textContent = 'Testing…';
    try { const r = await post(`/mailboxes/${b.dataset.test}/test`); r.ok ? toast('Connection works') : toast('Connection failed: ' + r.error, 'bad'); } catch (e) { toast(e.message, 'bad'); }
    route();
  }; });
  $$('[data-rm]').forEach((b) => { b.onclick = async () => {
    if (!(await confirmBox('Delete mailbox?', '<p>Emails still waiting to be sent from this mailbox will be marked as failed.</p>', 'Delete', true))) return;
    await del('/mailboxes/' + b.dataset.rm); route();
  }; });
}

function mailboxModal(mb) {
  const m = modal(mb ? 'Edit mailbox' : 'Add mailbox', `
    <label>Email provider<select id="mb-p">${Object.entries(PRESETS).map(([k, v]) => `<option value="${k}">${esc(v.label)}</option>`).join('')}</select></label>
    <p class="hint" style="margin:-8px 0 14px">Check the SMTP details in your host's help pages. Google and Microsoft may need an app password or SMTP turned on by an admin.</p>
    <div class="two"><label>Label<input id="mb-label" placeholder="Newsletter"></label><label>From name<input id="mb-fname" placeholder="LKZAI Team"></label></div>
    <label>From email<input id="mb-email" type="email" placeholder="hello@company.com"></label>
    <div class="two"><label>SMTP host<input id="mb-host" placeholder="smtp.hostinger.com"></label><label>Port<input id="mb-port" type="number" value="587"></label></div>
    <label class="check"><input type="checkbox" id="mb-secure">Use SSL (normally on for port 465, off for 587)</label>
    <div class="two"><label>SMTP username<input id="mb-user" placeholder="usually the full email address"></label><label>SMTP password<input id="mb-pass" type="password" autocomplete="new-password" placeholder="${mb ? 'leave empty to keep the current one' : ''}"></label></div>
    <div class="two"><label>Max emails per day<input id="mb-limit" type="number" min="1" max="5000" value="150"></label><label>Seconds between emails<input id="mb-delay" type="number" min="1" max="600" value="5"></label></div>
    <label class="check"><input type="checkbox" id="mb-ramp" checked>Warm-up: start at 20 a day and grow by 10 each day (recommended for new mailboxes)</label>
    <fieldset style="margin-top:12px"><legend>Sender signature <span class="mut" style="font-weight:400">(optional)</span></legend>
      <div class="two"><label>Name<input id="mb-sn"></label><label>Job title<input id="mb-st"></label></div><label style="margin:0">Phone<input id="mb-sp"></label></fieldset>
    <div class="err-text" id="mb-err"></div>
    <div class="row end gap"><button class="btn" data-no type="button">Cancel</button><button class="btn primary" id="mb-save" type="button">${mb ? 'Save' : 'Save and test connection'}</button></div>`);
  const set = (id, v) => { m.$('#' + id).value = v ?? ''; };
  if (mb) {
    set('mb-label', mb.label); set('mb-fname', mb.from_name); set('mb-email', mb.from_email); set('mb-host', mb.host); set('mb-port', mb.port);
    m.$('#mb-secure').checked = !!mb.secure; set('mb-user', mb.username); set('mb-limit', mb.daily_limit); set('mb-delay', mb.delay_seconds);
    m.$('#mb-ramp').checked = !!mb.ramp_up; set('mb-sn', mb.sig_name); set('mb-st', mb.sig_title); set('mb-sp', mb.sig_phone);
    m.$('#mb-p').value = Object.keys(PRESETS).find((k) => PRESETS[k].host === mb.host) || 'custom';
  } else { m.$('#mb-p').value = 'hostinger'; applyPreset(); }
  function applyPreset() {
    const p = PRESETS[m.$('#mb-p').value];
    if (p.host) set('mb-host', p.host);
    set('mb-port', p.port); m.$('#mb-secure').checked = p.secure;
  }
  m.$('#mb-p').onchange = applyPreset;
  m.$('#mb-port').oninput = () => { m.$('#mb-secure').checked = Number(m.$('#mb-port').value) === 465; };
  m.$('#mb-email').oninput = () => { const u = m.$('#mb-user'); if (!mb && (!u.value || u.dataset.auto)) { u.value = m.$('#mb-email').value; u.dataset.auto = '1'; } };
  m.$('#mb-user').addEventListener('input', () => { delete m.$('#mb-user').dataset.auto; });
  m.$('[data-no]').onclick = m.close;
  m.$('#mb-save').onclick = async () => {
    const g = (id) => m.$('#' + id).value.trim();
    const body = { company_id: state.cid, label: g('mb-label'), from_name: g('mb-fname'), from_email: g('mb-email'), host: g('mb-host'), port: Number(g('mb-port')), secure: m.$('#mb-secure').checked,
      username: g('mb-user'), password: m.$('#mb-pass').value, daily_limit: Number(g('mb-limit')), delay_seconds: Number(g('mb-delay')), ramp_up: m.$('#mb-ramp').checked,
      sig_name: g('mb-sn'), sig_title: g('mb-st'), sig_phone: g('mb-sp') };
    const btn = m.$('#mb-save'); btn.disabled = true;
    try {
      const saved = mb ? await put('/mailboxes/' + mb.id, body) : await post('/mailboxes', body);
      m.close();
      if (!mb) {
        const t = await post(`/mailboxes/${saved.id}/test`);
        t.ok ? toast('Mailbox saved and the connection works') : toast('Saved, but the connection failed: ' + t.error, 'bad');
      } else toast('Mailbox saved');
      route();
    } catch (e) { m.$('#mb-err').textContent = e.message; btn.disabled = false; }
  };
}

/* ---------- boot ---------- */
async function boot() {
  if (!state.token) return renderLogin();
  try {
    renderShell();
    await loadCompanies();
    if (!location.hash) location.hash = state.companies.length ? '#/overview' : '#/companies';
    route();
  } catch (e) {
    if (state.token) { $('#root').innerHTML = `<div class="login"><div class="card login-card"><h2>Cannot load MailHub</h2><p class="err-text">${esc(e.message)}</p><button class="btn primary" onclick="location.reload()">Try again</button></div></div>`; }
  }
}
window.addEventListener('hashchange', () => { if (state.token) route(); });
boot();
})();
