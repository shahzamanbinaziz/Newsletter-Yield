<?php
// Public tracking endpoints. These are the links and the pixel inside every email (see .htaccess: /t/...).
declare(strict_types=1);
require __DIR__ . '/src/bootstrap.php';

header('X-Content-Type-Options: nosniff');
header('Referrer-Policy: no-referrer');

// Link scanners and previewers open every link. They are saved but not counted as real people.
const BOT_RE = '/bot|crawl|spider|preview|scanner|slurp|curl|wget|python|headless|facebookexternalhit|proofpoint|mimecast|barracuda|safelinks/i';

function record_event(string $type, array $msg, string $url): void
{
    $ua = substr($_SERVER['HTTP_USER_AGENT'] ?? '', 0, 300);
    $ip = trim(explode(',', $_SERVER['HTTP_X_FORWARDED_FOR'] ?? ($_SERVER['REMOTE_ADDR'] ?? ''))[0]);
    run('INSERT INTO events(message_id,campaign_id,contact_id,type,url,ip,ua,bot,created_at) VALUES(?,?,?,?,?,?,?,?,?)',
        [$msg['id'], $msg['campaign_id'], $msg['contact_id'], $type, $url, substr($ip, 0, 64), $ua, preg_match(BOT_RE, $ua) ? 1 : 0, now()]);
}
function find_message(string $token): ?array { return one('SELECT * FROM messages WHERE token=?', [substr($token, 0, 64)]); }

function html_page(string $title, string $inner, int $status = 200): never
{
    http_response_code($status);
    header('Content-Type: text/html; charset=utf-8');
    header('Cache-Control: no-store');
    echo '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>' . esc($title) . '</title>
<style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#f4f4f7;font-family:Arial,Helvetica,sans-serif;color:#222}
.c{background:#fff;border-radius:12px;padding:36px;max-width:420px;margin:16px;text-align:center;box-shadow:0 4px 24px rgba(0,0,0,.08)}
h1{font-size:22px;margin:0 0 12px}p{color:#555;line-height:1.5}button{background:#4B2A8A;color:#fff;border:0;border-radius:8px;padding:12px 24px;font-size:15px;font-weight:bold;cursor:pointer}</style></head>
<body><div class="c">' . $inner . '</div></body></html>';
    exit;
}

$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
$path = parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH) ?: '/';
if (!preg_match('#/t/([ocu])/([^/]+)$#', $path, $m)) { http_response_code(404); echo 'Not found.'; exit; }
[, $kind, $arg] = $m;
$arg = rawurldecode($arg);

if ($kind === 'o') { // open pixel
    $msg = find_message(preg_replace('/\.gif$/i', '', $arg));
    if ($msg) record_event('open', $msg, '');
    $gif = base64_decode('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7');
    header('Content-Type: image/gif');
    header('Content-Length: ' . strlen($gif));
    header('Cache-Control: no-store, no-cache, must-revalidate, private');
    echo $gif;
    exit;
}

if ($kind === 'c') { // click redirect
    $url = (string)($_GET['u'] ?? '');
    $sig = (string)($_GET['s'] ?? '');
    if (!preg_match('#^https?://#i', $url) || !safe_equal(link_sig($arg, $url), $sig)) { http_response_code(400); echo 'Invalid link.'; exit; }
    $msg = find_message($arg);
    if ($msg) record_event('click', $msg, $url);
    header('Location: ' . str_replace(["\r", "\n"], '', $url), true, 302);
    exit;
}

// Unsubscribe
if ($arg === 'preview' && $method === 'GET') html_page('Preview', '<h1>Preview only</h1><p>In a real email this link lets the reader unsubscribe.</p>');
$msg = find_message($arg);
if (!$msg) html_page('Not found', '<h1>Link not found</h1><p>This unsubscribe link is not valid.</p>', 404);
$contact = one('SELECT * FROM contacts WHERE id=?', [$msg['contact_id']]);
$company = one('SELECT c.name FROM companies c JOIN campaigns k ON k.company_id=c.id WHERE k.id=?', [$msg['campaign_id']]);
$done = '<h1>You are unsubscribed</h1><p>' . esc($contact['email']) . ' will not receive more emails from ' . esc($company['name']) . '.</p>';

if ($method === 'POST') { // POST does the unsubscribe. Gmail/Yahoo "one-click unsubscribe" also sends a POST to this URL.
    if ($contact['status'] === 'active') {
        run("UPDATE contacts SET status='unsubscribed', unsubscribed_at=? WHERE id=?", [now(), $contact['id']]);
        record_event('unsubscribe', $msg, '');
    }
    html_page('Unsubscribed', $done);
}
// GET only shows a confirmation button, because mail security scanners "click" every link.
if ($contact['status'] === 'unsubscribed') html_page('Unsubscribed', $done);
html_page('Unsubscribe', '<h1>Unsubscribe?</h1><p>Stop emails from <b>' . esc($company['name']) . '</b> to ' . esc($contact['email']) . '.</p>
<form method="post"><button type="submit">Yes, unsubscribe me</button></form>');
