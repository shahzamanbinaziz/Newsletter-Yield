<?php
// Dashboard API. Everything the dashboard needs lives behind /api/... (see .htaccess).
declare(strict_types=1);
require __DIR__ . '/src/bootstrap.php';

class ApiError extends Exception
{
    public function __construct(string $m, public int $status = 400) { parent::__construct($m); }
}
function bad(string $m, int $status = 400): never { throw new ApiError($m, $status); }

function out($data, int $status = 200): never
{
    http_response_code($status);
    header('Content-Type: application/json; charset=utf-8');
    header('Cache-Control: no-store');
    echo json_encode($data, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE | JSON_PARTIAL_OUTPUT_ON_ERROR);
    exit;
}

set_exception_handler(static function (Throwable $e) {
    if ($e instanceof ApiError) out(['error' => $e->getMessage()], $e->status);
    error_log('MailHub error: ' . $e->getMessage() . ' @ ' . $e->getFile() . ':' . $e->getLine());
    out(['error' => 'Something went wrong on the server.'], 500);
});

header('X-Content-Type-Options: nosniff');
header('Referrer-Policy: no-referrer');

/* ---------- CORS (only needed if the dashboard is hosted somewhere else, e.g. GitHub Pages) ---------- */
$origin = $_SERVER['HTTP_ORIGIN'] ?? '';
if ($origin !== '' && in_array(rtrim($origin, '/'), cfg('allowed_origins'), true)) {
    header('Access-Control-Allow-Origin: ' . $origin);
    header('Vary: Origin');
    header('Access-Control-Allow-Headers: Authorization, Content-Type');
    header('Access-Control-Allow-Methods: GET,POST,PUT,DELETE,OPTIONS');
}
$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
if ($method === 'OPTIONS') { http_response_code(204); exit; }

$path = rtrim(parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH) ?: '/', '/');
if (preg_match('#/health$#', $path)) out(['ok' => true]);
if (!preg_match('#/api(/.*)?$#', $path, $pm)) bad('Not found.', 404);
$route = $pm[1] ?? '/';

$host = $_SERVER['HTTP_HOST'] ?? '';
if (cfg('insecure') && !preg_match('/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/', $host)) {
    bad('Open config.php on your hosting and set a new "secret" and "admin_password" first.', 503);
}

$BODY = json_decode((string)file_get_contents('php://input'), true);
if (!is_array($BODY)) $BODY = [];
$QUERY = $_GET;

/* ---------- helpers ---------- */
function auth_header(): string
{
    foreach (['HTTP_AUTHORIZATION', 'REDIRECT_HTTP_AUTHORIZATION'] as $k) if (!empty($_SERVER[$k])) return (string)$_SERVER[$k];
    if (function_exists('getallheaders')) foreach (getallheaders() as $k => $v) if (strcasecmp($k, 'Authorization') === 0) return (string)$v;
    return '';
}
function require_company(): array
{
    global $BODY, $QUERY;
    $id = (int)($QUERY['company_id'] ?? $BODY['company_id'] ?? 0);
    $c = one('SELECT * FROM companies WHERE id=?', [$id]);
    if (!$c) bad('Select a company first.');
    return $c;
}
function pub_company(array $c): array
{
    $sig = parse_json_or($c['signature_json'] ?? '{}', []);
    if (!$sig) $sig = new stdClass();
    elseif (empty($sig['socials'])) $sig['socials'] = new stdClass();
    unset($c['signature_json']);
    $c['signature'] = $sig;
    return $c;
}
function valid_color($c): bool { return is_string($c) && preg_match('/^#[0-9a-fA-F]{6}$/', $c) === 1; }
function clean_signature($s): array
{
    $s = is_array($s) ? $s : [];
    $socials = [];
    foreach (['linkedin', 'x', 'instagram', 'facebook', 'youtube'] as $k) {
        if (is_array($s['socials'] ?? null) && !empty($s['socials'][$k])) $socials[$k] = str_clip($s['socials'][$k], 300);
    }
    return [
        'template' => in_array($s['template'] ?? '', ['classic', 'modern', 'minimal'], true) ? $s['template'] : 'classic',
        'name' => str_clip($s['name'] ?? '', 100), 'title' => str_clip($s['title'] ?? '', 100), 'phone' => str_clip($s['phone'] ?? '', 40),
        'email' => str_clip($s['email'] ?? '', 120), 'website' => str_clip($s['website'] ?? '', 200), 'tagline' => str_clip($s['tagline'] ?? '', 160),
        'logo_url' => str_clip($s['logo_url'] ?? '', 500), 'color' => valid_color($s['color'] ?? '') ? $s['color'] : '', 'socials' => $socials,
    ];
}
function company_fields(array $b, ?array $ex = null): array
{
    $name = str_clip($b['name'] ?? '', 120) ?: ($ex['name'] ?? '');
    if ($name === '') bad('Company name is required.');
    return [
        'name' => $name,
        'color' => valid_color($b['brand_color'] ?? '') ? $b['brand_color'] : ($ex ? $ex['brand_color'] : '#4B2A8A'),
        'website' => str_clip($b['website'] ?? ($ex['website'] ?? ''), 200),
        'logo' => str_clip($b['logo_url'] ?? ($ex['logo_url'] ?? ''), 500),
        'address' => str_clip($b['address'] ?? ($ex['address'] ?? ''), 300),
        'sig' => json_encode(clean_signature($b['signature'] ?? ($ex ? parse_json_or($ex['signature_json'], []) : null)), JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE),
    ];
}
function pub_mailbox(array $m): array
{
    unset($m['password_enc'], $m['next_send_ts']);
    $m['sent_today'] = $m['sent_date'] === today() ? (int)$m['sent_today'] : 0;
    $m['effective_limit'] = effective_limit($m);
    return $m;
}
function mailbox_fields(array $b, ?array $ex = null): array
{
    $e = $ex ?? [];
    $host = str_clip($b['host'] ?? ($e['host'] ?? ''), 200);
    $port = (int)($b['port'] ?? ($e['port'] ?? 0));
    $from = strtolower(str_clip($b['from_email'] ?? ($e['from_email'] ?? ''), 200));
    if ($host === '') bad('SMTP host is required.');
    if (!($port > 0 && $port < 65536)) bad('SMTP port is not valid.');
    if (!is_email($from)) bad('From email is not valid.');
    $pw = !empty($b['password']) ? encrypt_text((string)$b['password']) : ($e['password_enc'] ?? '');
    if ($pw === '') bad('SMTP password is required.');
    $limit = (int)($b['daily_limit'] ?? ($e['daily_limit'] ?? 150)) ?: 150;
    $delay = (int)($b['delay_seconds'] ?? ($e['delay_seconds'] ?? 5)) ?: 5;
    return [
        'label' => str_clip($b['label'] ?? ($e['label'] ?? ''), 80) ?: $from,
        'from_name' => str_clip($b['from_name'] ?? ($e['from_name'] ?? ''), 100) ?: $from,
        'from_email' => $from, 'host' => $host, 'port' => $port,
        'secure' => ($b['secure'] ?? ($e['secure'] ?? 0)) ? 1 : 0,
        'username' => str_clip($b['username'] ?? ($e['username'] ?? ''), 200) ?: $from,
        'pw' => $pw,
        'daily_limit' => max(1, min(5000, $limit)),
        'delay_seconds' => max(1, min(600, $delay)),
        'ramp_up' => ($b['ramp_up'] ?? ($e['ramp_up'] ?? 1)) ? 1 : 0,
        'sig_name' => str_clip($b['sig_name'] ?? ($e['sig_name'] ?? ''), 100),
        'sig_title' => str_clip($b['sig_title'] ?? ($e['sig_title'] ?? ''), 100),
        'sig_phone' => str_clip($b['sig_phone'] ?? ($e['sig_phone'] ?? ''), 40),
    ];
}
function pub_campaign(array $c): array { $c['mailbox_ids'] = array_map('intval', parse_json_or($c['mailbox_ids'], [])); return $c; }
function campaign_fields(array $b, array $company, ?array $ex = null): array
{
    $e = $ex ?? [];
    $name = str_clip($b['name'] ?? ($e['name'] ?? ''), 120);
    if ($name === '') bad('Campaign name is required.');
    $listId = array_key_exists('list_id', $b) ? ((int)$b['list_id'] ?: null) : ($e['list_id'] ?? null);
    if ($listId && !one('SELECT id FROM lists WHERE id=? AND company_id=?', [$listId, $company['id']])) bad('List not found.');
    $ids = is_array($b['mailbox_ids'] ?? null) ? array_map('intval', $b['mailbox_ids']) : array_map('intval', parse_json_or($e['mailbox_ids'] ?? '[]', []));
    $ids = array_values(array_filter($ids, static fn($id) => one('SELECT id FROM mailboxes WHERE id=? AND company_id=?', [$id, $company['id']])));
    return [
        'name' => $name, 'subject' => str_clip($b['subject'] ?? ($e['subject'] ?? ''), 200), 'preheader' => str_clip($b['preheader'] ?? ($e['preheader'] ?? ''), 200),
        'html' => mb_substr((string)($b['html'] ?? ($e['html'] ?? '')), 0, 500000), 'list_id' => $listId ?: null, 'ids' => json_encode($ids),
    ];
}
function stats_for(int $id): array
{
    $by = static fn(string $s) => count_of('SELECT COUNT(*) FROM messages WHERE campaign_id=? AND status=?', [$id, $s]);
    $uniq = static fn(string $t) => count_of('SELECT COUNT(DISTINCT message_id) FROM events WHERE campaign_id=? AND type=? AND bot=0', [$id, $t]);
    return [
        'total' => count_of('SELECT COUNT(*) FROM messages WHERE campaign_id=?', [$id]),
        'sent' => $by('sent'), 'queued' => $by('queued'), 'failed' => $by('failed'), 'skipped' => $by('skipped'),
        'opened' => $uniq('open'), 'clicked' => $uniq('click'), 'unsubscribed' => $uniq('unsubscribe'),
        'total_clicks' => count_of("SELECT COUNT(*) FROM events WHERE campaign_id=? AND type='click' AND bot=0", [$id]),
        'bot_events' => count_of('SELECT COUNT(*) FROM events WHERE campaign_id=? AND bot=1', [$id]),
    ];
}
function sample_contact(): array { return ['first_name' => 'Alex', 'last_name' => 'Morgan', 'email' => 'alex@example.com']; }
function find_or_404(string $table, $id, string $what): array
{
    $r = one("SELECT * FROM $table WHERE id=?", [(int)$id]);
    if (!$r) bad("$what not found.", 404);
    return $r;
}

/* ---------- login (public, rate limited) ---------- */
if ($method === 'POST' && $route === '/login') {
    $ip = substr($_SERVER['REMOTE_ADDR'] ?? '?', 0, 64);
    $f = one('SELECT * FROM login_attempts WHERE ip=?', [$ip]) ?: ['n' => 0, 't' => time()];
    if (time() - (int)$f['t'] > 900) $f = ['n' => 0, 't' => time()];
    if ((int)$f['n'] >= 10) bad('Too many attempts. Try again in 15 minutes.', 429);
    $okEmail = safe_equal(strtolower(trim((string)($BODY['email'] ?? ''))), cfg('admin_email'));
    $okPass = safe_equal((string)($BODY['password'] ?? ''), cfg('admin_password'));
    if (!($okEmail && $okPass)) {
        run('INSERT OR REPLACE INTO login_attempts(ip,n,t) VALUES(?,?,?)', [$ip, (int)$f['n'] + 1, (int)$f['t']]);
        bad('Wrong email or password.', 401);
    }
    run('DELETE FROM login_attempts WHERE ip=?', [$ip]);
    out(['token' => make_auth_token(cfg('admin_email')), 'email' => cfg('admin_email')]);
}

if (!verify_auth_token(preg_replace('/^Bearer\s+/i', '', auth_header()))) out(['error' => 'Please sign in.'], 401);

/* ---------- routes ---------- */
$routes = [];
function on(string $m, string $re, callable $fn): void { global $routes; $routes[] = [$m, '#^' . $re . '$#', $fn]; }

/* companies and signature */
on('GET', '/companies', function () {
    $rows = many("SELECT c.*,
        (SELECT COUNT(*) FROM contacts WHERE company_id=c.id AND status='active') AS contacts,
        (SELECT COUNT(*) FROM campaigns WHERE company_id=c.id) AS campaigns,
        (SELECT COUNT(*) FROM mailboxes WHERE company_id=c.id) AS mailboxes FROM companies c ORDER BY c.name");
    return array_map('pub_company', $rows);
});
on('POST', '/companies', function () {
    global $BODY;
    $f = company_fields($BODY);
    $id = run('INSERT INTO companies(name,website,logo_url,brand_color,address,signature_json,created_at) VALUES(?,?,?,?,?,?,?)',
        [$f['name'], $f['website'], $f['logo'], $f['color'], $f['address'], $f['sig'], now()]);
    return pub_company(one('SELECT * FROM companies WHERE id=?', [$id]));
});
on('PUT', '/companies/(\d+)', function ($a) {
    global $BODY;
    $ex = find_or_404('companies', $a[1], 'Company');
    $f = company_fields($BODY, $ex);
    run('UPDATE companies SET name=?,website=?,logo_url=?,brand_color=?,address=?,signature_json=? WHERE id=?',
        [$f['name'], $f['website'], $f['logo'], $f['color'], $f['address'], $f['sig'], $ex['id']]);
    return pub_company(one('SELECT * FROM companies WHERE id=?', [$ex['id']]));
});
on('DELETE', '/companies/(\d+)', function ($a) { run('DELETE FROM companies WHERE id=?', [(int)$a[1]]); return ['ok' => true]; });
on('POST', '/signature/preview', function () {
    global $BODY;
    $c = is_array($BODY['company'] ?? null) ? $BODY['company'] : [];
    $company = ['name' => str_clip($c['name'] ?? ''), 'website' => str_clip($c['website'] ?? ''), 'logo_url' => str_clip($c['logo_url'] ?? ''), 'brand_color' => $c['brand_color'] ?? '#4B2A8A'];
    $mb = !empty($BODY['mailbox_id']) ? one('SELECT * FROM mailboxes WHERE id=?', [(int)$BODY['mailbox_id']]) : null;
    $sample = $mb ?: ['from_name' => 'Your Name', 'from_email' => 'you@company.com'];
    $html = render_signature($company, $sample, clean_signature($BODY['signature'] ?? null));
    return ['html' => $html ?: '<p style="font-family:Arial;color:#888">Fill in your name or title to see the signature.</p>'];
});

/* mailboxes */
on('GET', '/mailboxes', function () {
    $c = require_company();
    return array_map('pub_mailbox', many('SELECT * FROM mailboxes WHERE company_id=? ORDER BY id', [$c['id']]));
});
on('POST', '/mailboxes', function () {
    global $BODY;
    $c = require_company();
    $f = mailbox_fields($BODY);
    $id = run('INSERT INTO mailboxes(company_id,label,from_name,from_email,host,port,secure,username,password_enc,daily_limit,delay_seconds,ramp_up,sig_name,sig_title,sig_phone,created_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
        [$c['id'], $f['label'], $f['from_name'], $f['from_email'], $f['host'], $f['port'], $f['secure'], $f['username'], $f['pw'], $f['daily_limit'], $f['delay_seconds'], $f['ramp_up'], $f['sig_name'], $f['sig_title'], $f['sig_phone'], now()]);
    return pub_mailbox(one('SELECT * FROM mailboxes WHERE id=?', [$id]));
});
on('PUT', '/mailboxes/(\d+)', function ($a) {
    global $BODY;
    $ex = find_or_404('mailboxes', $a[1], 'Mailbox');
    $f = mailbox_fields($BODY, $ex);
    run('UPDATE mailboxes SET label=?,from_name=?,from_email=?,host=?,port=?,secure=?,username=?,password_enc=?,daily_limit=?,delay_seconds=?,ramp_up=?,sig_name=?,sig_title=?,sig_phone=? WHERE id=?',
        [$f['label'], $f['from_name'], $f['from_email'], $f['host'], $f['port'], $f['secure'], $f['username'], $f['pw'], $f['daily_limit'], $f['delay_seconds'], $f['ramp_up'], $f['sig_name'], $f['sig_title'], $f['sig_phone'], $ex['id']]);
    return pub_mailbox(one('SELECT * FROM mailboxes WHERE id=?', [$ex['id']]));
});
on('DELETE', '/mailboxes/(\d+)', function ($a) {
    run("UPDATE messages SET status='failed', error='Mailbox was removed' WHERE mailbox_id=? AND status='queued'", [(int)$a[1]]);
    run('DELETE FROM mailboxes WHERE id=?', [(int)$a[1]]);
    return ['ok' => true];
});
// Tests the SMTP login. If it works the mailbox is re-activated.
on('POST', '/mailboxes/(\d+)/test', function ($a) {
    $mb = find_or_404('mailboxes', $a[1], 'Mailbox');
    try {
        smtp_verify($mb);
    } catch (Throwable $e) {
        $msg = mb_substr($e instanceof SmtpError ? $e->response : $e->getMessage(), 0, 300);
        run("UPDATE mailboxes SET status='error', last_error=? WHERE id=?", [$msg, $mb['id']]);
        return ['ok' => false, 'error' => $msg];
    }
    run("UPDATE mailboxes SET status='active', last_error='' WHERE id=?", [$mb['id']]);
    return ['ok' => true];
});

/* lists and contacts */
on('GET', '/lists', function () {
    $c = require_company();
    return many("SELECT l.*,
        (SELECT COUNT(*) FROM list_contacts lc JOIN contacts k ON k.id=lc.contact_id WHERE lc.list_id=l.id AND k.status='active') AS active_count,
        (SELECT COUNT(*) FROM list_contacts WHERE list_id=l.id) AS total FROM lists l WHERE l.company_id=? ORDER BY l.name", [$c['id']]);
});
on('POST', '/lists', function () {
    global $BODY;
    $c = require_company();
    $name = str_clip($BODY['name'] ?? '', 80);
    if ($name === '') bad('List name is required.');
    run('INSERT OR IGNORE INTO lists(company_id,name,created_at) VALUES(?,?,?)', [$c['id'], $name, now()]);
    return one('SELECT * FROM lists WHERE company_id=? AND name=?', [$c['id'], $name]);
});
on('DELETE', '/lists/(\d+)', function ($a) { run('DELETE FROM lists WHERE id=?', [(int)$a[1]]); return ['ok' => true]; });

on('GET', '/contacts', function () {
    global $QUERY;
    $c = require_company();
    $where = ['k.company_id=?'];
    $args = [$c['id']];
    if (!empty($QUERY['list_id'])) { $where[] = 'EXISTS (SELECT 1 FROM list_contacts lc WHERE lc.contact_id=k.id AND lc.list_id=?)'; $args[] = (int)$QUERY['list_id']; }
    if (!empty($QUERY['status'])) { $where[] = 'k.status=?'; $args[] = (string)$QUERY['status']; }
    if (!empty($QUERY['q'])) {
        $where[] = '(k.email LIKE ? OR k.first_name LIKE ? OR k.last_name LIKE ?)';
        $like = '%' . mb_substr((string)$QUERY['q'], 0, 80) . '%';
        array_push($args, $like, $like, $like);
    }
    $limit = min((int)($QUERY['limit'] ?? 0) ?: 50, 200);
    $offset = max(0, (int)($QUERY['offset'] ?? 0));
    $w = implode(' AND ', $where);
    $total = count_of("SELECT COUNT(*) FROM contacts k WHERE $w", $args);
    $rows = many("SELECT k.id,k.email,k.first_name,k.last_name,k.status,k.consent_source,k.consent_at,k.created_at FROM contacts k
        WHERE $w ORDER BY k.id DESC LIMIT $limit OFFSET $offset", $args);
    return ['total' => $total, 'rows' => $rows];
});
// The person importing must confirm that these people agreed to receive email.
on('POST', '/contacts/import', function () {
    global $BODY;
    $c = require_company();
    if (empty($BODY['confirmed'])) bad('Please confirm that these contacts agreed to receive your emails.');
    $consent = str_clip($BODY['consent_source'] ?? '', 120);
    if ($consent === '') bad('Consent source is required (for example "website signup form").');
    $rows = is_array($BODY['rows'] ?? null) ? array_slice($BODY['rows'], 0, 50000) : [];
    if (!$rows) bad('No contacts to import.');

    $listId = (int)($BODY['list_id'] ?? 0) ?: null;
    if (!$listId) {
        $name = str_clip($BODY['list_name'] ?? '', 80) ?: 'Main list';
        run('INSERT OR IGNORE INTO lists(company_id,name,created_at) VALUES(?,?,?)', [$c['id'], $name, now()]);
        $listId = (int)one('SELECT id FROM lists WHERE company_id=? AND name=?', [$c['id'], $name])['id'];
    } elseif (!one('SELECT id FROM lists WHERE id=? AND company_id=?', [$listId, $c['id']])) {
        bad('List not found.');
    }

    $out = ['added' => 0, 'updated' => 0, 'invalid' => 0, 'suppressed' => 0, 'duplicates' => 0];
    $seen = [];
    $pdo = db();
    $pdo->beginTransaction();
    try {
        foreach ($rows as $row) {
            $row = is_array($row) ? $row : [];
            $email = strtolower(str_clip($row['email'] ?? '', 254));
            if (!is_email($email)) { $out['invalid']++; continue; }
            if (isset($seen[$email])) { $out['duplicates']++; continue; }
            $seen[$email] = true;
            $first = str_clip($row['first_name'] ?? '', 80);
            $last = str_clip($row['last_name'] ?? '', 80);
            $ex = one('SELECT * FROM contacts WHERE company_id=? AND email=?', [$c['id'], $email]);
            if ($ex) {
                if ($ex['status'] !== 'active') { $out['suppressed']++; continue; } // unsubscribed or bounced people are never re-added
                run("UPDATE contacts SET first_name=CASE WHEN ?<>'' THEN ? ELSE first_name END, last_name=CASE WHEN ?<>'' THEN ? ELSE last_name END WHERE id=?", [$first, $first, $last, $last, $ex['id']]);
                run('INSERT OR IGNORE INTO list_contacts(list_id,contact_id) VALUES(?,?)', [$listId, $ex['id']]);
                $out['updated']++;
            } else {
                $id = run('INSERT INTO contacts(company_id,email,first_name,last_name,consent_source,consent_at,token,created_at) VALUES(?,?,?,?,?,?,?,?)',
                    [$c['id'], $email, $first, $last, $consent, now(), random_token(), now()]);
                run('INSERT OR IGNORE INTO list_contacts(list_id,contact_id) VALUES(?,?)', [$listId, $id]);
                $out['added']++;
            }
        }
        $pdo->commit();
    } catch (Throwable $e) {
        $pdo->rollBack();
        throw $e;
    }
    return $out + ['list_id' => $listId];
});
on('DELETE', '/contacts/(\d+)', function ($a) {
    $k = find_or_404('contacts', $a[1], 'Contact');
    if ($k['status'] !== 'active') bad('Unsubscribed and bounced contacts are kept so they are never emailed again.');
    run('DELETE FROM contacts WHERE id=?', [$k['id']]);
    return ['ok' => true];
});
on('POST', '/contacts/(\d+)/unsubscribe', function ($a) {
    run("UPDATE contacts SET status='unsubscribed', unsubscribed_at=? WHERE id=? AND status='active'", [now(), (int)$a[1]]);
    return ['ok' => true];
});

/* campaigns */
on('GET', '/campaigns', function () {
    $c = require_company();
    return array_map(static function ($x) { $x = pub_campaign($x); unset($x['html']); $x['stats'] = stats_for((int)$x['id']); return $x; },
        many('SELECT * FROM campaigns WHERE company_id=? ORDER BY id DESC', [$c['id']]));
});
on('POST', '/campaigns/preview', function () {
    global $BODY;
    $c = require_company();
    $mb = !empty($BODY['mailbox_id']) ? one('SELECT * FROM mailboxes WHERE id=? AND company_id=?', [(int)$BODY['mailbox_id'], $c['id']]) : null;
    $built = build_email(
        ['subject' => str_clip($BODY['subject'] ?? '', 200), 'preheader' => str_clip($BODY['preheader'] ?? '', 200), 'html' => mb_substr((string)($BODY['html'] ?? ''), 0, 500000)],
        sample_contact(), $c, $mb, ['token' => 'preview'], false);
    return ['html' => $built['html'], 'subject' => $built['subject']];
});
on('POST', '/campaigns', function () {
    global $BODY;
    $c = require_company();
    $f = campaign_fields($BODY, $c);
    $id = run('INSERT INTO campaigns(company_id,name,subject,preheader,html,list_id,mailbox_ids,created_at) VALUES(?,?,?,?,?,?,?,?)',
        [$c['id'], $f['name'], $f['subject'], $f['preheader'], $f['html'], $f['list_id'], $f['ids'], now()]);
    return pub_campaign(one('SELECT * FROM campaigns WHERE id=?', [$id]));
});
on('GET', '/campaigns/(\d+)', function ($a) {
    $c = find_or_404('campaigns', $a[1], 'Campaign');
    return pub_campaign($c) + ['stats' => stats_for((int)$c['id'])];
});
on('PUT', '/campaigns/(\d+)', function ($a) {
    global $BODY;
    $ex = find_or_404('campaigns', $a[1], 'Campaign');
    if (!in_array($ex['status'], ['draft', 'scheduled'], true)) bad('Only draft or scheduled campaigns can be edited.');
    $f = campaign_fields($BODY, one('SELECT * FROM companies WHERE id=?', [$ex['company_id']]), $ex);
    run('UPDATE campaigns SET name=?,subject=?,preheader=?,html=?,list_id=?,mailbox_ids=? WHERE id=?', [$f['name'], $f['subject'], $f['preheader'], $f['html'], $f['list_id'], $f['ids'], $ex['id']]);
    return pub_campaign(one('SELECT * FROM campaigns WHERE id=?', [$ex['id']]));
});
on('DELETE', '/campaigns/(\d+)', function ($a) {
    $ex = one('SELECT status FROM campaigns WHERE id=?', [(int)$a[1]]);
    if ($ex && $ex['status'] === 'sending') bad('Pause the campaign before deleting it.');
    run('DELETE FROM campaigns WHERE id=?', [(int)$a[1]]);
    return ['ok' => true];
});
on('POST', '/campaigns/(\d+)/schedule', function ($a) {
    global $BODY;
    $c = find_or_404('campaigns', $a[1], 'Campaign');
    if (!in_array($c['status'], ['draft', 'scheduled'], true)) bad('This campaign was already started.');
    if (trim((string)$c['subject']) === '') bad('Add a subject line first.');
    if (trim((string)$c['html']) === '') bad('The email has no content yet.');
    if (!$c['list_id']) bad('Choose a list to send to.');
    if (!parse_json_or($c['mailbox_ids'], [])) bad('Choose at least one mailbox to send from.');
    $now = ms_now();
    $at = !empty($BODY['at']) ? strtotime((string)$BODY['at']) : false;
    $at = $at === false ? $now : max($now, $at * 1000);
    run("UPDATE campaigns SET status='scheduled', scheduled_at=?, note='' WHERE id=?", [iso_from_ms($at), $c['id']]);
    return pub_campaign(one('SELECT * FROM campaigns WHERE id=?', [$c['id']]));
});
on('POST', '/campaigns/(\d+)/unschedule', function ($a) { run("UPDATE campaigns SET status='draft', scheduled_at=NULL WHERE id=? AND status='scheduled'", [(int)$a[1]]); return ['ok' => true]; });
on('POST', '/campaigns/(\d+)/pause', function ($a) { run("UPDATE campaigns SET status='paused' WHERE id=? AND status='sending'", [(int)$a[1]]); return ['ok' => true]; });
on('POST', '/campaigns/(\d+)/resume', function ($a) { run("UPDATE campaigns SET status='sending' WHERE id=? AND status='paused'", [(int)$a[1]]); return ['ok' => true]; });
on('POST', '/campaigns/(\d+)/test', function ($a) {
    global $BODY;
    $c = find_or_404('campaigns', $a[1], 'Campaign');
    $to = strtolower(str_clip($BODY['to'] ?? '', 254));
    if (!is_email($to)) bad('Enter a valid test email address.');
    $mb = one('SELECT * FROM mailboxes WHERE id=? AND company_id=?', [(int)($BODY['mailbox_id'] ?? 0), $c['company_id']]);
    if (!$mb) bad('Choose a mailbox to send the test from.');
    $company = one('SELECT * FROM companies WHERE id=?', [$c['company_id']]);
    $built = build_email($c, ['first_name' => 'there', 'last_name' => 'Morgan', 'email' => $to], $company, $mb, ['token' => 'preview'], false);
    $built['subject'] = '[TEST] ' . $built['subject'];
    try {
        smtp_send_mail($mb, $to, $built);
        return ['ok' => true];
    } catch (Throwable $e) {
        return ['ok' => false, 'error' => mb_substr($e instanceof SmtpError ? $e->response : $e->getMessage(), 0, 300)];
    }
});
on('GET', '/campaigns/(\d+)/stats', function ($a) {
    $c = find_or_404('campaigns', $a[1], 'Campaign');
    $links = many("SELECT url, COUNT(*) AS clicks, COUNT(DISTINCT message_id) AS unique_clicks FROM events
        WHERE campaign_id=? AND type='click' AND bot=0 GROUP BY url ORDER BY clicks DESC LIMIT 10", [$c['id']]);
    $timeline = array_reverse(many("SELECT substr(created_at,1,13) AS hour,
        COUNT(DISTINCT CASE WHEN type='open' THEN message_id END) AS opens,
        COUNT(DISTINCT CASE WHEN type='click' THEN message_id END) AS clicks
        FROM events WHERE campaign_id=? AND bot=0 AND type IN ('open','click') GROUP BY hour ORDER BY hour DESC LIMIT 72", [$c['id']]));
    return ['campaign' => pub_campaign($c), 'stats' => stats_for((int)$c['id']), 'links' => $links, 'timeline' => $timeline];
});
on('GET', '/campaigns/(\d+)/recipients', function ($a) {
    global $QUERY;
    $id = (int)$a[1];
    $filter = (string)($QUERY['filter'] ?? 'all');
    $limit = min((int)($QUERY['limit'] ?? 0) ?: 50, 200);
    $offset = max(0, (int)($QUERY['offset'] ?? 0));
    $base = "SELECT m.id, k.email, k.first_name, k.status AS contact_status, m.status, m.sent_at, m.error,
        (SELECT COUNT(*) FROM events e WHERE e.message_id=m.id AND e.type='open' AND e.bot=0) AS opens,
        (SELECT COUNT(*) FROM events e WHERE e.message_id=m.id AND e.type='click' AND e.bot=0) AS clicks,
        (SELECT COUNT(*) FROM events e WHERE e.message_id=m.id AND e.type='unsubscribe') AS unsubs
        FROM messages m JOIN contacts k ON k.id=m.contact_id WHERE m.campaign_id=?";
    $cond = ['all' => '1=1', 'opened' => 'opens>0', 'clicked' => 'clicks>0', 'failed' => "status='failed'", 'queued' => "status='queued'", 'unsubscribed' => 'unsubs>0'][$filter] ?? '1=1';
    $total = count_of("SELECT COUNT(*) FROM ($base) WHERE $cond", [$id]);
    $rows = many("SELECT * FROM ($base) WHERE $cond ORDER BY id LIMIT $limit OFFSET $offset", [$id]);
    return ['total' => $total, 'rows' => $rows];
});

/* AI newsletter writer (Gemini) */
on('GET', '/ai/status', function () { return ['enabled' => ai_enabled()]; });
on('POST', '/ai/newsletter', function () {
    global $BODY;
    $c = require_company();
    if (!ai_enabled()) bad('AI is not set up yet. Add your Gemini key as gemini_key in config.php.');
    $prompt = str_clip($BODY['prompt'] ?? '', 3000);
    if (mb_strlen($prompt) < 10) bad('Describe the newsletter in a sentence or two.');
    $tone = ['friendly' => 'warm and friendly', 'professional' => 'professional and confident', 'bold' => 'bold, energetic and direct', 'playful' => 'playful and witty'][$BODY['tone'] ?? ''] ?? 'warm and friendly';
    $lang = in_array($BODY['language'] ?? '', ['english', 'roman_urdu', 'urdu'], true) ? $BODY['language'] : 'english';
    $length = in_array($BODY['length'] ?? '', ['short', 'medium', 'long'], true) ? $BODY['length'] : 'medium';
    @set_time_limit(120);
    try {
        return ai_generate($c, $prompt, $tone, $lang, $length);
    } catch (RuntimeException $e) {
        bad($e->getMessage(), 502);
    }
});

/* overview */
on('GET', '/overview', function () {
    $c = require_company();
    $cid = $c['id'];
    $since = iso_from_ms(ms_now() - 30 * 864e5);
    $ev = static fn(string $t) => count_of('SELECT COUNT(DISTINCT e.message_id) FROM events e JOIN campaigns c ON c.id=e.campaign_id WHERE c.company_id=? AND e.type=? AND e.bot=0 AND e.created_at>=?', [$cid, $t, $since]);
    $days = [];
    for ($i = 13; $i >= 0; $i--) $days[] = gmdate('Y-m-d', (int)(time() - $i * 86400));
    $series = static function (string $sql) use ($cid, $days) {
        $o = [];
        foreach (many($sql, [$cid, $days[0]]) as $r) $o[$r['d']] = (int)$r['n'];
        return $o;
    };
    $sentBy = $series("SELECT substr(m.sent_at,1,10) d, COUNT(*) n FROM messages m JOIN campaigns c ON c.id=m.campaign_id WHERE c.company_id=? AND m.status='sent' AND substr(m.sent_at,1,10)>=? GROUP BY d");
    $openBy = $series("SELECT substr(e.created_at,1,10) d, COUNT(DISTINCT e.message_id) n FROM events e JOIN campaigns c ON c.id=e.campaign_id WHERE c.company_id=? AND e.type='open' AND e.bot=0 AND substr(e.created_at,1,10)>=? GROUP BY d");
    $clickBy = $series("SELECT substr(e.created_at,1,10) d, COUNT(DISTINCT e.message_id) n FROM events e JOIN campaigns c ON c.id=e.campaign_id WHERE c.company_id=? AND e.type='click' AND e.bot=0 AND substr(e.created_at,1,10)>=? GROUP BY d");
    return [
        'sent_30d' => count_of("SELECT COUNT(*) FROM messages m JOIN campaigns c ON c.id=m.campaign_id WHERE c.company_id=? AND m.status='sent' AND m.sent_at>=?", [$cid, $since]),
        'opened_30d' => $ev('open'), 'clicked_30d' => $ev('click'), 'unsubscribed_30d' => $ev('unsubscribe'),
        'active_contacts' => count_of("SELECT COUNT(*) FROM contacts WHERE company_id=? AND status='active'", [$cid]),
        'suppressed' => count_of("SELECT COUNT(*) FROM contacts WHERE company_id=? AND status<>'active'", [$cid]),
        'campaigns' => count_of('SELECT COUNT(*) FROM campaigns WHERE company_id=?', [$cid]),
        'mailboxes' => count_of('SELECT COUNT(*) FROM mailboxes WHERE company_id=?', [$cid]),
        'timeline' => array_map(static fn($d) => ['day' => $d, 'sent' => $sentBy[$d] ?? 0, 'opens' => $openBy[$d] ?? 0, 'clicks' => $clickBy[$d] ?? 0], $days),
    ];
});

/* ---------- dispatch ---------- */
foreach ($routes as [$m, $re, $fn]) {
    if ($m === $method && preg_match($re, $route, $a)) out($fn($a));
}
bad('Not found.', 404);
