<?php
// Email signature designer. Output is table based HTML with inline styles,
// because that is what Gmail, Outlook and phone mail apps render reliably.
declare(strict_types=1);

function sig_url($u): string
{
    $u = trim((string)($u ?? ''));
    if ($u === '') return '';
    return preg_match('#^https?://#i', $u) ? $u : 'https://' . $u;
}
function sig_color($c): string { return preg_match('/^#[0-9a-fA-F]{6}$/', (string)$c) ? (string)$c : '#4B2A8A'; }
function sig_pick(...$vals): string
{
    foreach ($vals as $v) if ($v !== null && $v !== '' && $v !== false) return (string)$v;
    return '';
}

/** Combines company defaults, saved signature settings and (optional) sender mailbox details. */
function sig_merge(array $company, ?array $mailbox, ?array $override): array
{
    $s = $override ?? parse_json_or($company['signature_json'] ?? '{}', []);
    $mb = $mailbox ?? [];
    return [
        'template' => in_array($s['template'] ?? '', ['classic', 'modern', 'minimal'], true) ? $s['template'] : 'classic',
        'name' => sig_pick($mb['sig_name'] ?? '', $s['name'] ?? '', $mb['from_name'] ?? ''),
        'title' => sig_pick($mb['sig_title'] ?? '', $s['title'] ?? ''),
        'phone' => sig_pick($mb['sig_phone'] ?? '', $s['phone'] ?? ''),
        'email' => sig_pick($s['email'] ?? '', $mb['from_email'] ?? ''),
        'website' => sig_pick($s['website'] ?? '', $company['website'] ?? ''),
        'tagline' => sig_pick($s['tagline'] ?? ''),
        'logo_url' => sig_pick($s['logo_url'] ?? '', $company['logo_url'] ?? ''),
        'color' => sig_color(sig_pick($s['color'] ?? '', $company['brand_color'] ?? '')),
        'socials' => is_array($s['socials'] ?? null) ? $s['socials'] : [],
        'company' => (string)($company['name'] ?? ''),
    ];
}

function sig_social_links(array $s): string
{
    $labels = ['linkedin' => 'LinkedIn', 'x' => 'X', 'instagram' => 'Instagram', 'facebook' => 'Facebook', 'youtube' => 'YouTube'];
    $out = [];
    foreach ($labels as $k => $label) {
        $u = sig_url($s['socials'][$k] ?? '');
        if ($u !== '') $out[] = '<a href="' . esc($u) . '" style="color:' . $s['color'] . ';text-decoration:none;font-weight:bold">' . $label . '</a>';
    }
    return implode(' &nbsp;|&nbsp; ', $out);
}

function sig_site_text(string $w): string { return preg_replace(['#^https?://#i', '#/$#'], '', $w); }

function sig_contact_lines(array $s): string
{
    $rows = [];
    if ($s['phone'] !== '') $rows[] = '<span style="color:#888">T</span>&nbsp; ' . esc($s['phone']);
    if ($s['email'] !== '') $rows[] = '<span style="color:#888">E</span>&nbsp; <a href="mailto:' . esc($s['email']) . '" style="color:#333;text-decoration:none">' . esc($s['email']) . '</a>';
    if ($s['website'] !== '') $rows[] = '<span style="color:#888">W</span>&nbsp; <a href="' . esc(sig_url($s['website'])) . '" style="color:#333;text-decoration:none">' . esc(sig_site_text($s['website'])) . '</a>';
    return implode('<br>', $rows);
}

const SIG_WRAP = 'font-family:Arial,Helvetica,sans-serif;font-size:13px;line-height:1.5;color:#333333;';

function sig_role(array $s, string $glue): string
{
    return implode($glue, array_map('esc', array_filter([$s['title'], $s['company']], static fn($x) => $x !== '')));
}

function sig_classic(array $s): string
{
    $logo = $s['logo_url'] !== ''
        ? '<td style="padding-right:16px;border-right:3px solid ' . $s['color'] . ';vertical-align:top"><img src="' . esc(sig_url($s['logo_url'])) . '" alt="' . esc($s['company']) . '" width="90" style="display:block;width:90px;max-width:90px;height:auto;border:0"></td>'
        : '';
    $role = sig_role($s, ' &middot; ');
    $soc = sig_social_links($s);
    return '<table cellpadding="0" cellspacing="0" border="0" style="' . SIG_WRAP . 'margin-top:28px"><tr>' . $logo . "\n"
        . '<td style="padding-left:' . ($s['logo_url'] !== '' ? 16 : 0) . 'px;vertical-align:top">' . "\n"
        . '<div style="font-size:17px;font-weight:bold;color:#111111">' . esc($s['name']) . '</div>' . "\n"
        . ($role !== '' ? '<div style="color:' . $s['color'] . ';font-weight:bold;margin-bottom:6px">' . $role . '</div>' : '') . "\n"
        . '<div>' . sig_contact_lines($s) . '</div>' . "\n"
        . ($s['tagline'] !== '' ? '<div style="margin-top:8px;font-style:italic;color:#666">' . esc($s['tagline']) . '</div>' : '') . "\n"
        . ($soc !== '' ? '<div style="margin-top:8px;font-size:12px">' . $soc . '</div>' : '') . "\n"
        . '</td></tr></table>';
}

function sig_modern(array $s): string
{
    $role = sig_role($s, ' &middot; ');
    $soc = sig_social_links($s);
    return '<table cellpadding="0" cellspacing="0" border="0" style="' . SIG_WRAP . 'margin-top:28px;width:100%;max-width:460px"><tr><td style="border-top:4px solid ' . $s['color'] . ';padding-top:14px">' . "\n"
        . '<div style="font-size:20px;font-weight:bold;color:#111111;letter-spacing:-0.3px">' . esc($s['name']) . '</div>' . "\n"
        . ($role !== '' ? '<div style="color:#666;margin-bottom:8px">' . $role . '</div>' : '') . "\n"
        . '<div>' . sig_contact_lines($s) . '</div>' . "\n"
        . ($s['tagline'] !== '' ? '<div style="margin-top:8px;color:' . $s['color'] . ';font-weight:bold">' . esc($s['tagline']) . '</div>' : '') . "\n"
        . ($soc !== '' ? '<div style="margin-top:8px;font-size:12px">' . $soc . '</div>' : '') . "\n"
        . ($s['logo_url'] !== '' ? '<div style="margin-top:14px"><img src="' . esc(sig_url($s['logo_url'])) . '" alt="' . esc($s['company']) . '" width="120" style="display:block;width:120px;max-width:120px;height:auto;border:0"></div>' : '') . "\n"
        . '</td></tr></table>';
}

function sig_minimal(array $s): string
{
    $role = sig_role($s, ', ');
    $bits = [];
    if ($s['phone'] !== '') $bits[] = esc($s['phone']);
    if ($s['website'] !== '') $bits[] = '<a href="' . esc(sig_url($s['website'])) . '" style="color:' . $s['color'] . ';text-decoration:none">' . esc(sig_site_text($s['website'])) . '</a>';
    $soc = sig_social_links($s);
    return '<div style="' . SIG_WRAP . 'margin-top:28px">' . "\n"
        . '<div style="color:#999">--</div>' . "\n"
        . '<div style="font-weight:bold;color:#111111">' . esc($s['name']) . '</div>' . "\n"
        . ($role !== '' ? '<div>' . $role . '</div>' : '') . "\n"
        . ($bits ? '<div>' . implode(' &nbsp;|&nbsp; ', $bits) . '</div>' : '') . "\n"
        . ($soc !== '' ? '<div style="font-size:12px">' . $soc . '</div>' : '') . "\n"
        . '</div>';
}

function render_signature(array $company, ?array $mailbox, ?array $override = null): string
{
    $s = sig_merge($company, $mailbox, $override);
    if ($s['name'] === '' && $s['title'] === '' && $s['phone'] === '' && $s['website'] === '' && $s['tagline'] === '') return '';
    return match ($s['template']) {
        'modern' => sig_modern($s),
        'minimal' => sig_minimal($s),
        default => sig_classic($s),
    };
}
