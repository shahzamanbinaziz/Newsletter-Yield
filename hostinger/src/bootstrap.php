<?php
// Loads settings and the other source files. Every entry point (api.php, track.php, cron.php) starts here.
declare(strict_types=1);

date_default_timezone_set('UTC');
mb_internal_encoding('UTF-8');
define('MH_ROOT', dirname(__DIR__));

/** Settings come from config.php (copy of config.sample.php). Environment variables override them (used by tests). */
function cfg(?string $key = null)
{
    static $c = null;
    if ($c === null) {
        $file = MH_ROOT . '/config.php';
        $user = is_file($file) ? require $file : [];
        if (!is_array($user)) $user = [];
        $env = static function (string $k) {
            $v = getenv($k);
            return ($v !== false && $v !== '') ? $v : null;
        };
        $origins = $env('ALLOWED_ORIGIN') ?? implode(',', (array)($user['allowed_origins'] ?? []));
        $c = [
            'base_url' => rtrim((string)($env('BASE_URL') ?? $user['base_url'] ?? ''), '/'),
            'secret' => (string)($env('APP_SECRET') ?? $user['secret'] ?? 'dev-secret-change-me'),
            'admin_email' => strtolower(trim((string)($env('ADMIN_EMAIL') ?? $user['admin_email'] ?? 'admin@example.com'))),
            'admin_password' => (string)($env('ADMIN_PASSWORD') ?? $user['admin_password'] ?? 'change-me-now'),
            'allowed_origins' => array_values(array_filter(array_map(static fn($s) => rtrim(trim($s), '/'), explode(',', $origins)))),
            'db_path' => (string)($env('DB_PATH') ?? $user['db_path'] ?? MH_ROOT . '/data/mailhub.sqlite'),
            'tick_ms' => (int)($env('TICK_MS') ?? $user['tick_ms'] ?? 1000),
            'cron_key' => (string)($env('CRON_KEY') ?? $user['cron_key'] ?? ''),
            'cron_seconds' => (int)($env('CRON_RUN_SECONDS') ?? $user['cron_seconds'] ?? 55),
            'allow_self_signed' => ($env('SMTP_ALLOW_SELF_SIGNED') ?? '') === '1',
            // "Write with AI" (Google Gemini). Get a free key at https://aistudio.google.com/apikey
            'gemini_key' => trim((string)($env('GEMINI_API_KEY') ?? $user['gemini_key'] ?? '')),
            'gemini_models' => array_values(array_filter(array_map('trim', $env('GEMINI_MODELS') !== null ? explode(',', $env('GEMINI_MODELS')) : (array)($user['gemini_models'] ?? ['gemini-3.8-flash', 'gemini-3.5-flash-lite'])))),
            'gemini_endpoint' => (string)($env('GEMINI_ENDPOINT') ?? 'https://generativelanguage.googleapis.com/v1beta/models'),
        ];
        $c['insecure'] = $c['secret'] === 'dev-secret-change-me' || $c['admin_password'] === 'change-me-now';
    }
    return $key === null ? $c : $c[$key];
}

/** Public address of this install. Tracking and unsubscribe links in emails start with it. */
function base_url(): string
{
    $b = cfg('base_url');
    if ($b !== '') return $b;
    if (empty($_SERVER['HTTP_HOST'])) return ''; // cron has no request, so base_url must be set in config.php
    $https = (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off') || ($_SERVER['HTTP_X_FORWARDED_PROTO'] ?? '') === 'https';
    $dir = rtrim(str_replace('\\', '/', dirname($_SERVER['SCRIPT_NAME'] ?? '/')), '/');
    return ($https ? 'https://' : 'http://') . $_SERVER['HTTP_HOST'] . $dir;
}

require_once __DIR__ . '/util.php';
require_once __DIR__ . '/db.php';
require_once __DIR__ . '/smtp.php';
require_once __DIR__ . '/signature.php';
require_once __DIR__ . '/mailer.php';
require_once __DIR__ . '/ai.php';
require_once __DIR__ . '/worker.php';
