// End-to-end test: starts a fake SMTP server and the real MailHub server, then walks through the whole flow.
// Run with:  npm i  &&  npm test
const { spawn } = require('child_process');
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { SMTPServer } = require('smtp-server');
const { simpleParser } = require('mailparser');

const PORT = 3055;
const BASE = `http://localhost:${PORT}`;
const inbox = [];
let pass = 0;
const ok = (name) => { pass++; console.log('  PASS', name); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 40000, step = 300) {
  const t = Date.now();
  while (Date.now() - t < ms) { const v = await fn(); if (v) return v; await sleep(step); }
  throw new Error('timeout waiting for condition');
}

const smtp = new SMTPServer({
  authOptional: false, allowInsecureAuth: true, disabledCommands: ['STARTTLS'],
  onAuth(auth, s, cb) { auth.username === 'tester' && auth.password === 'secret' ? cb(null, { user: 1 }) : cb(new Error('Invalid login')); },
  onRcptTo(addr, s, cb) {
    if (addr.address.startsWith('bounce@')) { const e = new Error('550 5.1.1 User unknown'); e.responseCode = 550; return cb(e); }
    cb();
  },
  async onData(stream, s, cb) { inbox.push(await simpleParser(stream)); cb(); },
});

(async () => {
  await new Promise((r) => smtp.listen(2525, '127.0.0.1', r));
  const dbFile = path.join(os.tmpdir(), 'mailhub-test-' + Date.now() + '.db');
  const env = { ...process.env, PORT, DB_PATH: dbFile, APP_SECRET: 'test-secret', ADMIN_EMAIL: 'admin@test.com', ADMIN_PASSWORD: 'pw12345', BASE_URL: BASE, TICK_MS: 250, ALLOWED_ORIGIN: 'https://user.github.io' };
  const procs = [];
  if (process.env.TARGET === 'php') {
    // PHP edition (folder "hostinger"): web server + the cron worker running for 120 seconds
    const dir = path.join(__dirname, '..', '..', 'hostinger');
    procs.push(spawn('php', ['-S', '127.0.0.1:' + PORT, 'dev-router.php'], { cwd: dir, env: { ...env, PHP_CLI_SERVER_WORKERS: '4' }, stdio: ['ignore', 'inherit', 'inherit'] }));
    procs.push(spawn('php', ['cron.php'], { cwd: dir, env: { ...env, CRON_RUN_SECONDS: '120' }, stdio: ['ignore', 'inherit', 'inherit'] }));
  } else {
    procs.push(spawn('node', ['server.js'], { cwd: path.join(__dirname, '..'), env, stdio: ['ignore', 'inherit', 'inherit'] }));
  }
  const stop = () => { procs.forEach((p) => p.kill()); smtp.close(); try { fs.rmSync(dbFile, { force: true }); } catch {} };

  try {
    await until(async () => { try { return (await fetch(BASE + '/health')).ok; } catch { return false; } }, 10000, 200);

    let token = '';
    const api = async (p, method = 'GET', body) => {
      const res = await fetch(BASE + '/api' + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined });
      const json = await res.json().catch(() => ({}));
      return { status: res.status, ...json, json };
    };

    console.log('Auth');
    assert.strictEqual((await api('/companies')).status, 401); ok('API needs login');
    assert.strictEqual((await api('/login', 'POST', { email: 'admin@test.com', password: 'nope' })).status, 401); ok('wrong password rejected');
    token = (await api('/login', 'POST', { email: 'admin@test.com', password: 'pw12345' })).token;
    assert.ok(token); ok('login works');
    const pre = await fetch(BASE + '/api/companies', { method: 'OPTIONS', headers: { Origin: 'https://user.github.io' } });
    assert.strictEqual(pre.headers.get('access-control-allow-origin'), 'https://user.github.io'); ok('CORS allows the GitHub Pages origin');
    const evil = await fetch(BASE + '/api/companies', { method: 'OPTIONS', headers: { Origin: 'https://evil.com' } });
    assert.strictEqual(evil.headers.get('access-control-allow-origin'), null); ok('CORS blocks other origins');

    console.log('Company + signature');
    const co = await api('/companies', 'POST', { name: 'LKZAI', website: 'https://lkzai.com', brand_color: '#3826E3', address: '1 Main St, Lahore', signature: { template: 'modern', name: 'Fahad Bin Aziz', title: 'Growth Manager', phone: '+92 300 0000000', tagline: 'Own your audience', socials: { linkedin: 'linkedin.com/in/x' } } });
    assert.ok(co.id); ok('company created');
    const prev = await api('/signature/preview', 'POST', { company: { name: 'LKZAI', brand_color: '#3826E3' }, signature: { template: 'classic', name: 'Test Person', title: 'CEO' } });
    assert.ok(prev.html.includes('Test Person') && prev.html.includes('#3826E3')); ok('signature preview renders');

    console.log('Mailboxes');
    const mbBody = { company_id: co.id, label: 'Hello', from_name: 'LKZAI Team', from_email: 'hello@lkzai.com', host: '127.0.0.1', port: 2525, secure: false, username: 'tester', password: 'secret', daily_limit: 100, delay_seconds: 1, ramp_up: false };
    const mb1 = await api('/mailboxes', 'POST', mbBody);
    const mb2 = await api('/mailboxes', 'POST', { ...mbBody, label: 'News', from_email: 'news@lkzai.com', sig_name: 'News Desk', sig_title: 'Editor' });
    assert.ok(mb1.id && !JSON.stringify(mb1).includes('password')); ok('mailbox saved, password never returned');
    assert.strictEqual((await api(`/mailboxes/${mb1.id}/test`, 'POST')).ok, true); ok('SMTP connection test passes');
    const badMb = await api('/mailboxes', 'POST', { ...mbBody, label: 'Bad', password: 'wrong' });
    const badTest = await api(`/mailboxes/${badMb.id}/test`, 'POST');
    assert.strictEqual(badTest.ok, false); ok('wrong SMTP password is reported');
    await api(`/mailboxes/${badMb.id}`, 'DELETE');

    console.log('Contacts');
    const rows = [
      { email: 'ann@example.com', first_name: 'Ann' }, { email: 'bob@example.com', first_name: 'Bob' },
      { email: 'cara@example.com' }, { email: 'dan@example.com', first_name: 'Dan' },
      { email: 'bounce@example.com' }, { email: 'not-an-email' }, { email: 'ANN@example.com' },
    ];
    assert.strictEqual((await api('/contacts/import', 'POST', { company_id: co.id, list_name: 'Main', consent_source: 'signup form', rows })).status, 400); ok('import refused without consent confirmation');
    const imp = await api('/contacts/import', 'POST', { company_id: co.id, list_name: 'Main', consent_source: 'signup form', confirmed: true, rows });
    assert.deepStrictEqual([imp.added, imp.invalid, imp.duplicates], [5, 1, 1]); ok('import: 5 added, 1 invalid, 1 duplicate');

    console.log('Campaign sending');
    const html = '<h1>Hello {{first_name|there}}</h1><p>Read <a href="https://example.com/post?a=1&amp;b=2">our post</a> or <a href="https://example.com/other">this</a>.</p>';
    const camp = await api('/campaigns', 'POST', { company_id: co.id, name: 'Welcome', subject: 'Hi {{first_name|friend}}', preheader: 'Quick note', html, list_id: imp.list_id, mailbox_ids: [mb1.id, mb2.id] });
    assert.strictEqual((await api('/campaigns/' + camp.id + '/schedule', 'POST', {})).status, 'scheduled'); ok('campaign scheduled');
    await until(async () => (await api('/campaigns/' + camp.id)).status === 'sent');
    ok('campaign finished sending');
    assert.strictEqual(inbox.length, 4); ok('4 real emails delivered (bounce address rejected)');
    const m = inbox.find((x) => x.to.text.includes('ann@'));
    assert.strictEqual(m.subject, 'Hi Ann'); ok('subject personalised');
    assert.ok(m.html.includes('Hello Ann')); ok('body personalised');
    assert.ok(/\/t\/c\/[\w-]+\?u=/.test(m.html) && /\/t\/o\/[\w-]+\.gif/.test(m.html)); ok('links rewritten + open pixel present');
    assert.ok(m.html.includes('Fahad Bin Aziz') || m.html.includes('News Desk')); ok('company signature appended');
    assert.ok(m.html.includes('Unsubscribe') && m.html.includes('1 Main St, Lahore')); ok('footer has unsubscribe + address');
    const rawHeader = (k) => (m.headerLines.find((h) => h.key === k) || {}).line || '';
    assert.ok(/<http[^>]+\/t\/u\/[\w-]+>/.test(rawHeader('list-unsubscribe')) && /One-Click/.test(rawHeader('list-unsubscribe-post'))); ok('List-Unsubscribe + one-click headers set');
    assert.ok(m.text && m.text.includes('Hello Ann')); ok('plain text version included');
    const senders = new Set(inbox.map((x) => x.from.value[0].address));
    assert.strictEqual(senders.size, 2); ok('both mailboxes used (round robin)');
    const cs = (await api('/campaigns/' + camp.id)).stats;
    assert.deepStrictEqual([cs.sent, cs.failed], [4, 1]); ok('stats: 4 sent, 1 failed');
    const list = (await api('/contacts?company_id=' + co.id + '&status=bounced'));
    assert.strictEqual(list.total, 1); ok('hard-bounced address marked as bounced');

    console.log('Tracking');
    const tokenOf = (html) => html.match(/\/t\/o\/([\w-]+)\.gif/)[1];
    const tok = tokenOf(m.html);
    await fetch(`${BASE}/t/o/${tok}.gif`, { headers: { 'User-Agent': 'Mozilla/5.0 Real Browser' } });
    await fetch(`${BASE}/t/o/${tok}.gif`, { headers: { 'User-Agent': 'Mozilla/5.0 Real Browser' } });
    const clickUrl = m.html.match(/href="(http[^"]*\/t\/c\/[^"]+)"/)[1].replace(/&amp;/g, '&');
    const c1 = await fetch(clickUrl, { redirect: 'manual', headers: { 'User-Agent': 'Mozilla/5.0 Real Browser' } });
    assert.strictEqual(c1.status, 302); assert.strictEqual(c1.headers.get('location'), 'https://example.com/post?a=1&b=2'); ok('click redirects to the original link');
    const tampered = await fetch(clickUrl.replace(/u=[^&]+/, 'u=' + encodeURIComponent('https://evil.com')), { redirect: 'manual' });
    assert.strictEqual(tampered.status, 400); ok('tampered link refused (no open redirect)');
    await fetch(clickUrl, { redirect: 'manual', headers: { 'User-Agent': 'Microsoft Defender SafeLinks scanner' } });
    const st = (await api('/campaigns/' + camp.id + '/stats'));
    assert.deepStrictEqual([st.stats.opened, st.stats.clicked, st.stats.total_clicks], [1, 1, 1]); ok('unique opens/clicks counted, scanner bot ignored');
    assert.strictEqual(st.links[0].url, 'https://example.com/post?a=1&b=2'); ok('top links report');
    const rec = await api(`/campaigns/${camp.id}/recipients?filter=clicked`);
    assert.strictEqual(rec.total, 1); ok('recipient filter: clicked');

    console.log('Unsubscribe');
    const unsubUrl = m.html.match(/href="(http[^"]*\/t\/u\/[^"]+)"/)[1];
    const page = await (await fetch(unsubUrl)).text();
    assert.ok(page.includes('<form')); ok('GET shows confirmation only');
    assert.strictEqual((await api('/contacts?company_id=' + co.id + '&status=unsubscribed')).total, 0); ok('GET did not unsubscribe (scanner safe)');
    await fetch(unsubUrl, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'List-Unsubscribe=One-Click' });
    assert.strictEqual((await api('/contacts?company_id=' + co.id + '&status=unsubscribed')).total, 1); ok('POST (one-click) unsubscribes');
    const re = await api('/contacts/import', 'POST', { company_id: co.id, list_name: 'Main', consent_source: 'x', confirmed: true, rows: [{ email: 'ann@example.com' }] });
    assert.strictEqual(re.suppressed, 1); ok('unsubscribed contact cannot be re-imported');
    const ann = (await api('/contacts?company_id=' + co.id + '&q=ann')).rows[0];
    assert.strictEqual((await api('/contacts/' + ann.id, 'DELETE')).status, 400); ok('suppressed contact cannot be deleted');

    console.log('Daily limit');
    const slow = await api('/mailboxes', 'POST', { ...mbBody, label: 'Limited', from_email: 'limited@lkzai.com', daily_limit: 2 });
    const rows2 = ['w', 'x', 'y', 'z'].map((n) => ({ email: n + '@limit.test', first_name: n }));
    const imp2 = await api('/contacts/import', 'POST', { company_id: co.id, list_name: 'Limit test', consent_source: 'test', confirmed: true, rows: rows2 });
    const c2 = await api('/campaigns', 'POST', { company_id: co.id, name: 'Limit', subject: 'L', html: '<p>Hi</p>', list_id: imp2.list_id, mailbox_ids: [slow.id] });
    await api('/campaigns/' + c2.id + '/schedule', 'POST', {});
    await until(async () => (await api('/campaigns/' + c2.id)).stats.sent >= 2);
    await sleep(4000);
    const s2 = await api('/campaigns/' + c2.id);
    assert.deepStrictEqual([s2.stats.sent, s2.stats.queued, s2.status], [2, 2, 'sending']); ok('stops at the mailbox daily limit and waits for tomorrow');

    console.log('Overview + test send');
    const ov = await api('/overview?company_id=' + co.id);
    assert.ok(ov.sent_30d >= 6 && ov.timeline.length === 14); ok('overview numbers + 14 day timeline');
    const ts = await api('/campaigns/' + camp.id + '/test', 'POST', { to: 'me@example.com', mailbox_id: mb1.id });
    assert.strictEqual(ts.ok, true); await until(() => inbox.some((x) => x.subject.startsWith('[TEST]'))); ok('test send works and is not tracked');
    const tm = inbox.find((x) => x.subject.startsWith('[TEST]'));
    assert.ok(!tm.html.includes('/t/o/')); ok('test email has no tracking pixel');

    console.log(`\nAll ${pass} checks passed.`);
    stop();
    process.exit(0);
  } catch (e) {
    console.error('\nFAILED:', e.message);
    console.error(e.stack.split('\n').slice(0, 4).join('\n'));
    stop();
    process.exit(1);
  }
})();
