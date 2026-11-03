<?php
declare(strict_types=1);

/** {{first_name}}, {{first_name|there}} (fallback), {{last_name}}, {{email}}, {{company}}, {{unsubscribe_url}} */
function fill_vars($str, array $ctx, bool $raw = false): string
{
    return (string)preg_replace_callback('/\{\{\s*([a-z_]+)\s*(?:\|([^}]*))?\}\}/i', static function ($m) use ($ctx, $raw) {
        $k = strtolower($m[1]);
        if (!array_key_exists($k, $ctx)) return $m[0];
        $v = $ctx[$k] !== '' ? $ctx[$k] : trim($m[2] ?? '');
        return ($raw || $k === 'unsubscribe_url') ? $v : esc($v);
    }, (string)($str ?? ''));
}

function html_to_text(string $html): string
{
    $t = preg_replace('#<(style|script)[\s\S]*?</\1>#i', '', $html);
    $t = preg_replace_callback('#<a\s[^>]*href=["\']([^"\']+)["\'][^>]*>([\s\S]*?)</a>#i', static function ($m) {
        $txt = trim(preg_replace('/<[^>]+>/', '', $m[2]));
        return ($txt !== '' && $txt !== $m[1]) ? "$txt ({$m[1]})" : $m[1];
    }, $t);
    $t = preg_replace('#<br\s*/?>#i', "\n", $t);
    $t = preg_replace('#</(p|div|tr|h[1-6]|li)>#i', "\n", $t);
    $t = preg_replace('/<[^>]+>/', '', $t);
    $t = strtr($t, ['&nbsp;' => ' ', '&amp;' => '&', '&lt;' => '<', '&gt;' => '>', '&quot;' => '"', '&#39;' => "'", '&middot;' => '·']);
    $t = preg_replace('/[ \t]+\n/', "\n", $t);
    $t = preg_replace('/\n{3,}/', "\n\n", $t);
    return trim($t);
}

/**
 * Builds the final email for one contact.
 *  track=true  -> links go through our tracking address, an open pixel is added
 *  track=false -> used for previews and test sends
 */
function build_email(array $campaign, array $contact, array $company, ?array $mailbox, array $message, bool $track): array
{
    $base = base_url();
    $unsubUrl = $track ? "$base/t/u/{$message['token']}" : "$base/t/u/preview";
    $ctx = [
        'first_name' => (string)($contact['first_name'] ?? ''),
        'last_name' => (string)($contact['last_name'] ?? ''),
        'email' => (string)($contact['email'] ?? ''),
        'company' => (string)($company['name'] ?? ''),
        'unsubscribe_url' => $unsubUrl,
    ];

    $body = fill_vars($campaign['html'] ?? '', $ctx);
    if ($track) {
        $token = (string)$message['token'];
        $body = preg_replace_callback('/href\s*=\s*(["\'])(https?:\/\/[^"\']+)\1/i', static function ($m) use ($unsubUrl, $base, $token) {
            if (str_starts_with($m[2], $unsubUrl)) return $m[0];
            $clean = str_replace('&amp;', '&', $m[2]);
            return 'href=' . $m[1] . "$base/t/c/$token?u=" . rawurlencode($clean) . '&s=' . link_sig($token, $clean) . $m[1];
        }, $body);
    }

    $subject = fill_vars($campaign['subject'] ?? '', $ctx, true);
    $signature = render_signature($company, $mailbox);
    $hasOwnUnsub = preg_match('/\{\{\s*unsubscribe_url\s*\}\}/i', (string)($campaign['html'] ?? '')) === 1;
    $addr = trim((string)($company['address'] ?? ''));
    $footer = $hasOwnUnsub ? '' : '<div style="margin-top:32px;padding-top:16px;border-top:1px solid #eeeeee;font-size:12px;line-height:1.6;color:#888888;text-align:center">' . "\n"
        . 'You are receiving this email because you subscribed to updates from ' . esc($company['name'] ?? '') . '.' . ($addr !== '' ? '<br>' . esc($addr) : '') . '<br>' . "\n"
        . '<a href="' . esc($unsubUrl) . '" style="color:#888888">Unsubscribe</a></div>';
    $pre = !empty($campaign['preheader'])
        ? '<div style="display:none;max-height:0;overflow:hidden;opacity:0;font-size:1px;line-height:1px">' . esc(fill_vars($campaign['preheader'], $ctx, true)) . '</div>'
        : '';
    $pixel = $track ? '<img src="' . $base . '/t/o/' . $message['token'] . '.gif" width="1" height="1" alt="" style="display:block;width:1px;height:1px;border:0">' : '';

    $html = '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>' . esc($subject) . '</title></head>' . "\n"
        . '<body style="margin:0;padding:0;background:#f4f4f7">' . $pre . "\n"
        . '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f4f4f7"><tr><td align="center" style="padding:24px 12px">' . "\n"
        . '<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:640px;background:#ffffff;border-radius:8px"><tr>' . "\n"
        . '<td style="padding:32px;font-family:Arial,Helvetica,sans-serif;font-size:16px;line-height:1.6;color:#222222">' . $body . $signature . $footer . '</td></tr></table>' . "\n"
        . '</td></tr></table>' . $pixel . '</body></html>';

    $headers = $track ? ['List-Unsubscribe' => "<$unsubUrl>", 'List-Unsubscribe-Post' => 'List-Unsubscribe=One-Click'] : [];
    return [
        'subject' => $subject,
        'html' => $html,
        'text' => html_to_text($pixel !== '' ? str_replace($pixel, '', $html) : $html),
        'headers' => $headers,
    ];
}
