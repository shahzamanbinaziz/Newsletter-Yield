<?php
declare(strict_types=1);

function b64u(string $s): string { return rtrim(strtr(base64_encode($s), '+/', '-_'), '='); }
function b64u_dec(string $s) { return base64_decode(strtr($s, '-_', '+/'), true); }
function hmac_b64u(string $d): string { return b64u(hash_hmac('sha256', $d, cfg('secret'), true)); }
function safe_equal($a, $b): bool { return hash_equals((string)$a, (string)$b); }
function random_token(int $n = 18): string { return b64u(random_bytes($n)); }

/** ISO time with milliseconds, same format the dashboard already understands (2026-11-04T10:15:30.123Z). */
function now(): string
{
    $t = microtime(true);
    return gmdate('Y-m-d\TH:i:s', (int)$t) . sprintf('.%03dZ', (int)(($t - floor($t)) * 1000));
}
function iso_from_ms(float $ms): string
{
    $t = $ms / 1000;
    return gmdate('Y-m-d\TH:i:s', (int)$t) . sprintf('.%03dZ', (int)(($t - floor($t)) * 1000));
}
function today(): string { return gmdate('Y-m-d'); }
function ms_now(): float { return microtime(true) * 1000; }

function esc($s): string
{
    return strtr((string)($s ?? ''), ['&' => '&amp;', '<' => '&lt;', '>' => '&gt;', '"' => '&quot;', "'" => '&#39;']);
}
function str_clip($v, int $max = 200): string { return mb_substr(trim((string)($v ?? '')), 0, $max); }
function is_email($e): bool
{
    return is_string($e) && strlen($e) <= 254 && preg_match('/^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[^\s@<>()",;:]{2,}$/u', $e) === 1;
}
function parse_json_or($s, $default)
{
    $v = json_decode((string)$s, true);
    return $v === null ? $default : $v;
}

/* ---- login token (7 days) ---- */
function make_auth_token(string $email, int $days = 7): string
{
    $p = b64u(json_encode(['e' => $email, 'x' => (int)(ms_now() + $days * 864e5)]));
    return $p . '.' . hmac_b64u('auth.' . $p);
}
function verify_auth_token(?string $t): ?array
{
    if (!$t || strpos($t, '.') === false) return null;
    [$p, $s] = explode('.', $t, 2);
    if (!safe_equal(hmac_b64u('auth.' . $p), $s)) return null;
    $raw = b64u_dec($p);
    $o = $raw === false ? null : json_decode($raw, true);
    return (is_array($o) && ($o['x'] ?? 0) > ms_now()) ? $o : null;
}

/** Click links are signed so nobody can abuse /t/c/ as an open redirect. */
function link_sig(string $token, string $url): string { return substr(hmac_b64u('link.' . $token . '.' . $url), 0, 22); }

/* ---- SMTP passwords are stored encrypted (AES-256-GCM) ---- */
function enc_key(): string { return hash_hkdf('sha256', cfg('secret'), 32, 'mailhub-v1'); }
function encrypt_text(string $text): string
{
    $iv = random_bytes(12);
    $tag = '';
    $ct = openssl_encrypt($text, 'aes-256-gcm', enc_key(), OPENSSL_RAW_DATA, $iv, $tag, '', 16);
    return base64_encode($iv . $tag . $ct);
}
function decrypt_text(string $s): string
{
    $b = base64_decode($s, true);
    if ($b === false || strlen($b) < 28) throw new RuntimeException('Stored password is damaged.');
    $out = openssl_decrypt(substr($b, 28), 'aes-256-gcm', enc_key(), OPENSSL_RAW_DATA, substr($b, 0, 12), substr($b, 12, 16));
    if ($out === false) throw new RuntimeException('Cannot decrypt the SMTP password. Did the secret in config.php change? Re-enter the mailbox password.');
    return $out;
}

/** New mailboxes start slowly and grow daily. This protects the reputation of a fresh mailbox. */
function effective_limit(array $mb): int
{
    $lim = (int)$mb['daily_limit'];
    if (!empty($mb['ramp_up'])) {
        $days = max(0, (int)floor((time() - (int)strtotime((string)$mb['created_at'])) / 86400));
        $lim = min($lim, 20 + $days * 10);
    }
    return $lim;
}
