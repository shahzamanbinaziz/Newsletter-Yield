// Needs: php, node, and Playwright (npm i -g playwright). Mock Gemini + PHP edition + real browser: checks the "Write with AI" flow.
const http = require('http'), { spawn } = require('child_process'), path = require('path'), os = require('os'), fs = require('fs');
const { chromium } = require('playwright');
const assert = require('assert');
const dir = path.resolve(__dirname, '..', 'hostinger');
const seen = [];
let calls = 0;
const mock = http.createServer((req, res) => {
  let b = ''; req.on('data', d => b += d); req.on('end', () => {
    calls++;
    const body = JSON.parse(b || '{}');
    seen.push({ url: req.url, key: req.headers['x-goog-api-key'], body });
    if (req.url.includes('gemini-first')) { res.writeHead(429, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: { message: 'quota' } })); }
    const m = body.contents[0].parts[0].text.match(/Design direction: ([A-Za-z ]+)\./);
    if (!m) { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'OK' }] } }] })); }
    const dir = m[1];
    const html = `\`\`\`html\n<script>alert(1)</script><h1 onclick="x()" style="color:#5b2a9a">Hello {{first_name|there}} - ${dir}</h1><p>Some real looking body text for the newsletter.</p><a href="javascript:alert(2)" style="color:red">bad</a><a href="https://example.com">ok</a><iframe src="x"></iframe>\n\`\`\``;
    const text = JSON.stringify({ subject: 'Subject for ' + dir, preheader: 'Pre ' + dir, html });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ candidates: [{ content: { parts: [{ thought: true, text: 'thinking' }, { text }] } }] }));
  });
});
(async () => {
  await new Promise(r => mock.listen(2999, '127.0.0.1', r));
  const db = path.join(os.tmpdir(), 'ai-' + Date.now() + '.sqlite');
  const env = { ...process.env, PHP_CLI_SERVER_WORKERS: '4', DB_PATH: db, APP_SECRET: 's3cret', ADMIN_EMAIL: 'a@t.com', ADMIN_PASSWORD: 'pw12345', BASE_URL: 'http://127.0.0.1:8099',
    GEMINI_API_KEY: 'TESTKEY', GEMINI_MODELS: 'gemini-first,gemini-second', GEMINI_ENDPOINT: 'http://127.0.0.1:2999/v1beta/models' };
  const php = spawn('php', ['-S', '127.0.0.1:8099', 'dev-router.php'], { cwd: dir, env, stdio: 'ignore' });
  const done = (code) => { php.kill(); mock.close(); fs.rmSync(db, { force: true }); process.exit(code); };
  try {
    await new Promise(r => setTimeout(r, 800));
    const B = 'http://127.0.0.1:8099';
    const j = async (p, m = 'GET', body, tok) => { const r = await fetch(B + '/api' + p, { method: m, headers: { 'Content-Type': 'application/json', ...(tok ? { Authorization: 'Bearer ' + tok } : {}) }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, ...(await r.json()) }; };
    const tok = (await j('/login', 'POST', { email: 'a@t.com', password: 'pw12345' })).token;
    const co = await j('/companies', 'POST', { name: 'CompareHub', brand_color: '#0a7d5a', website: 'https://comparehub.blog' }, tok);
    assert.strictEqual((await j('/ai/status', 'GET', null, tok)).enabled, true); console.log('PASS status enabled');
    assert.strictEqual((await j('/ai/newsletter', 'POST', { company_id: co.id, prompt: 'short' }, tok)).status, 400); console.log('PASS too-short prompt refused');
    const r = await j('/ai/newsletter', 'POST', { company_id: co.id, prompt: 'Monthly update about our new free SEO checklist and a 20% offer', tone: 'bold', language: 'roman_urdu', length: 'short' }, tok);
    assert.strictEqual(r.variants.length, 3); assert.strictEqual(r.model, 'gemini-second'); console.log('PASS 3 variants, fell back to second model after 429');
    assert.ok(seen.every(s => s.key === 'TESTKEY')); console.log('PASS API key sent in header only');
    const last = seen[seen.length - 1].body;
    assert.ok(last.systemInstruction.parts[0].text.includes('Roman Urdu') && last.systemInstruction.parts[0].text.includes('#0a7d5a') && last.systemInstruction.parts[0].text.includes('https://comparehub.blog')); console.log('PASS prompt carries language, brand colour, website');
    const all = r.variants.map(v => v.html).join('');
    assert.ok(!/<script|<iframe|onclick|javascript:/i.test(all) && all.includes('https://example.com') && all.includes('{{first_name|there}}')); console.log('PASS html sanitised (script, iframe, onclick, javascript: removed)');
    assert.ok(!JSON.stringify(r).includes('TESTKEY')); console.log('PASS key never returned');

    // ---- key saved from the dashboard (no config.php editing) ----
    const db2 = path.join(os.tmpdir(), 'ai2-' + Date.now() + '.sqlite');
    const env2 = { ...env, DB_PATH: db2, GEMINI_API_KEY: '', GEMINI_MODELS: 'gemini-second' };
    const php2 = spawn('php', ['-S', '127.0.0.1:8098', 'dev-router.php'], { cwd: dir, env: env2, stdio: 'ignore' });
    try {
      await new Promise(r => setTimeout(r, 800));
      const B2 = 'http://127.0.0.1:8098';
      const j2 = async (p, m = 'GET', body, tok) => { const r = await fetch(B2 + '/api' + p, { method: m, headers: { 'Content-Type': 'application/json', ...(tok ? { Authorization: 'Bearer ' + tok } : {}) }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, ...(await r.json()) }; };
      const t2 = (await j2('/login', 'POST', { email: 'a@t.com', password: 'pw12345' })).token;
      const c2 = await j2('/companies', 'POST', { name: 'X' }, t2);
      assert.strictEqual((await j2('/ai/status', 'GET', null, t2)).enabled, false); console.log('PASS no key: AI disabled');
      assert.strictEqual((await j2('/settings', 'PUT', { gemini_key: 'short' }, t2)).status, 400); console.log('PASS obviously wrong key refused');
      const KEY = 'AIzaSyFAKE-KEY-1234567890abcdefXYZ';
      const sv = await j2('/settings', 'PUT', { gemini_key: KEY }, t2);
      assert.deepStrictEqual([sv.gemini_key_set, sv.gemini_key_source, sv.gemini_key_hint], [true, 'dashboard', 'AIza...fXYZ']); console.log('PASS key saved from dashboard, only a hint is returned');
      assert.ok(!JSON.stringify(await j2('/settings', 'GET', null, t2)).includes('FAKE-KEY')); console.log('PASS full key never returned');
      const raw = require('child_process').execFileSync('php', ['-r', `echo (new PDO('sqlite:${db2}'))->query("select v from settings")->fetchColumn();`]).toString();
      assert.ok(raw.length > 20 && !raw.includes('FAKE-KEY')); console.log('PASS key is encrypted in the database');
      assert.strictEqual((await j2('/ai/status', 'GET', null, t2)).enabled, true); console.log('PASS AI enabled after saving');
      seen.length = 0;
      assert.strictEqual((await j2('/settings/gemini-test', 'POST', {}, t2)).ok, true); assert.strictEqual(seen[0].key, KEY); console.log('PASS "Test key" works and uses the saved key');
      const g2 = await j2('/ai/newsletter', 'POST', { company_id: c2.id, prompt: 'A monthly update about our new free SEO checklist' }, t2);
      assert.strictEqual(g2.variants.length, 3); console.log('PASS generate works with the dashboard key');
      const bw = await chromium.launch(); const pw = await bw.newPage({ viewport: { width: 1100, height: 700 } });
      await pw.goto(B2 + '/'); await pw.fill('input[type=email]', 'a@t.com'); await pw.fill('input[type=password]', 'pw12345'); await pw.click('button[type=submit]');
      await pw.waitForSelector('#nav'); await pw.click('#nav a[data-k=settings]'); await pw.waitForSelector('text=Key saved');
      await pw.screenshot({ path: path.join(os.tmpdir(), 'settings.png') }); await bw.close(); console.log('PASS Settings page shows "Key saved"');
      assert.strictEqual((await j2('/settings', 'PUT', { gemini_key: '' }, t2)).gemini_key_set, false); console.log('PASS key can be removed');
    } finally { php2.kill(); fs.rmSync(db2, { force: true }); }

    // browser flow
    const br = await chromium.launch(); const pg = await br.newPage({ viewport: { width: 1280, height: 900 } });
    await pg.goto(B + '/'); await pg.fill('input[type=email]', 'a@t.com'); await pg.fill('input[type=password]', 'pw12345'); await pg.click('button[type=submit]');
    await pg.waitForSelector('text=Overview', { timeout: 8000 }).catch(() => {});
    await pg.goto(B + '/#/campaigns/new');
    await pg.waitForSelector('#ai-open:not([hidden])', { timeout: 8000 }); console.log('PASS Write with AI button visible');
    await pg.click('#ai-open');
    await pg.fill('#ai-prompt', 'Monthly update about our new free SEO checklist and a 20% offer until Friday');
    await pg.click('#ai-go');
    await pg.waitForSelector('.ai-card', { timeout: 15000 });
    assert.strictEqual(await pg.locator('.ai-card').count(), 3); console.log('PASS 3 design cards shown');
    await pg.screenshot({ path: path.join(os.tmpdir(), 'ai-modal.png') });
    await pg.click('[data-use="1"]');
    await pg.waitForTimeout(600);
    const html = await pg.inputValue('#f-html'); const subj = await pg.inputValue('#f-subject');
    assert.ok(html.includes('Bold announcement') && subj === 'Subject for Bold announcement'); console.log('PASS chosen design copied into the editor with subject');
    await pg.screenshot({ path: path.join(os.tmpdir(), 'ai-editor.png') });
    await br.close();
    console.log('\nAll AI checks passed.'); done(0);
  } catch (e) { console.error('FAILED:', e.message); done(1); }
})();
