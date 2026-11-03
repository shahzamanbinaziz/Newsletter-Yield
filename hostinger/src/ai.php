<?php
// "Write with AI": describes a newsletter in a few words, Gemini writes 3 designed variants.
// The API key stays on the server (config.php). The dashboard never sees it.
declare(strict_types=1);

function ai_enabled(): bool { return cfg('gemini_key') !== ''; }

/** Three different design directions, one request each (run in parallel, so it is fast). */
function ai_styles(): array
{
    return [
        ['name' => 'Clean editorial', 'brief' => 'Calm, readable magazine style. A strong headline, a short intro, 2-3 sections with small coloured subheadings, generous spacing, one clear button near the end. White background, brand colour only for headings and the button.'],
        ['name' => 'Bold announcement', 'brief' => 'Eye-catching. Start with a full-width coloured block in the brand colour (white text, big headline, one-line promise), then short punchy sections, a bullet list of key points with bold lead-ins, and a large centred button. Use light grey panels for highlights.'],
        ['name' => 'Short personal note', 'brief' => 'Looks like a personal email from a real person, not a designed template. Almost no styling: a greeting, 3 short paragraphs, one question the reader can reply to, and one plain text link instead of a button. Maximum warmth, minimum decoration.'],
    ];
}

function ai_system_prompt(array $company, string $tone, string $lang, string $length): string
{
    $color = sig_color($company['brand_color'] ?? '');
    $site = trim((string)($company['website'] ?? ''));
    $cta = $site !== '' ? sig_url($site) : 'https://example.com';
    $words = $length === 'short' ? 'about 120 words' : ($length === 'long' ? 'about 400 words' : 'about 250 words');
    $langRule = match ($lang) {
        'roman_urdu' => 'Write in Roman Urdu (Urdu written with English letters, natural everyday style).',
        'urdu' => 'Write in Urdu using Urdu script. Put dir="rtl" and text-align:right on the outermost div.',
        default => 'Write in clear, natural English.',
    };
    return "You are a senior email designer and copywriter working for the company \"" . ($company['name'] ?? '') . "\".\n"
        . "Return ONLY a JSON object, nothing else: {\"subject\": string, \"preheader\": string, \"html\": string}.\n\n"
        . "Rules for \"html\" (it is the BODY CONTENT of an email, placed inside a 576px white column):\n"
        . "- Inline styles only. No <html>, <head>, <body>, <style>, <script>, no external fonts, CSS or JavaScript.\n"
        . "- Use div, p, h1, h2, ul, li, a, strong, hr. Use a table only for multi-column blocks or a coloured block.\n"
        . "- Font is inherited (Arial). Body text colour #222222. Brand colour for accents: $color.\n"
        . "- Buttons are <a> tags styled with padding, background colour, white bold text, border-radius, text-decoration:none.\n"
        . "- Links must point to $cta unless the user gives another URL.\n"
        . "- Do not use images unless the user supplied an image URL. Never invent image URLs.\n"
        . "- Greet with {{first_name|there}} when it fits. {{company}} gives the company name. Do not add an unsubscribe link, signature or footer: they are added automatically.\n"
        . "- Never invent facts, numbers, prices, dates, testimonials or quotes that the user did not provide. Where a detail is missing write a clear placeholder in square brackets, e.g. [date].\n"
        . "- Length: $words.\n"
        . "- Tone: $tone.\n"
        . "- $langRule\n\n"
        . "Rules for \"subject\": at most 60 characters, specific, honest, no ALL CAPS, no spammy words (free, urgent, act now), at most one emoji.\n"
        . "Rules for \"preheader\": at most 100 characters, complements the subject, does not repeat it.";
}

/** Removes anything that could run code or break the email. The model is not trusted. */
function ai_clean_html(string $h): string
{
    $h = preg_replace('/^\s*```(?:html)?\s*|\s*```\s*$/i', '', $h);
    $h = preg_replace('#<!--.*?-->#s', '', $h);
    $h = preg_replace('#<(script|style|iframe|object|embed|form|svg|math|noscript|textarea|select|button)\b[^>]*>.*?</\1\s*>#is', '', $h);
    $h = preg_replace('#<(script|style|iframe|object|embed|form|link|meta|base|input|button|textarea|select|svg|math)\b[^>]*/?>#i', '', $h);
    $h = preg_replace('#</?(html|head|body|title)\b[^>]*>#i', '', $h);
    $h = preg_replace('/\son[a-z]+\s*=\s*("[^"]*"|\'[^\']*\'|[^\s>]+)/i', '', $h);
    $h = preg_replace('/(href|src)\s*=\s*(["\'])\s*(?:javascript|data|vbscript)\s*:[^"\']*\2/i', '$1=$2#$2', $h);
    return mb_substr(trim($h), 0, 100000);
}

function ai_parse(string $text): ?array
{
    $text = trim($text);
    $j = json_decode($text, true);
    if (!is_array($j)) {
        $a = strpos($text, '{');
        $b = strrpos($text, '}');
        if ($a !== false && $b !== false && $b > $a) $j = json_decode(substr($text, $a, $b - $a + 1), true);
    }
    if (!is_array($j) || empty($j['html']) || !is_string($j['html'])) return null;
    $html = ai_clean_html($j['html']);
    if (mb_strlen(strip_tags($html)) < 20) return null;
    return [
        'subject' => str_clip($j['subject'] ?? '', 200),
        'preheader' => str_clip($j['preheader'] ?? '', 200),
        'html' => $html,
    ];
}

function ai_error_message(int $status, ?array $body): string
{
    $msg = (string)($body['error']['message'] ?? '');
    if ($status === 400 && stripos($msg, 'API key') !== false) return 'Gemini says the API key is not valid. Check gemini_key in config.php.';
    if ($status === 401 || $status === 403) return 'Gemini refused the request (' . ($msg ?: 'permission denied') . '). Check gemini_key in config.php.';
    if ($status === 429) return 'Gemini free limit reached for now. Wait a minute and try again.';
    if ($status === 404) return 'Gemini model not found. Update gemini_models in config.php.';
    if ($status === 0) return 'Could not reach Gemini: ' . $msg;
    return 'Gemini error ' . $status . ($msg ? ': ' . mb_substr($msg, 0, 160) : '');
}

/** Runs several POST requests at the same time. Returns [key => [status, decodedBodyOrNull, errorText]]. */
function ai_http_multi(array $jobs): array
{
    if (!function_exists('curl_init')) throw new RuntimeException('PHP curl is not enabled on this hosting. Turn it on in hPanel, PHP Configuration, Extensions.');
    $mh = curl_multi_init();
    $hs = [];
    foreach ($jobs as $k => $j) {
        $ch = curl_init($j['url']);
        curl_setopt_array($ch, [
            CURLOPT_POST => true, CURLOPT_POSTFIELDS => $j['body'], CURLOPT_RETURNTRANSFER => true,
            CURLOPT_HTTPHEADER => ['Content-Type: application/json', 'x-goog-api-key: ' . cfg('gemini_key')],
            CURLOPT_TIMEOUT => 80, CURLOPT_CONNECTTIMEOUT => 10,
        ]);
        curl_multi_add_handle($mh, $ch);
        $hs[$k] = $ch;
    }
    do {
        $st = curl_multi_exec($mh, $running);
        if ($running) curl_multi_select($mh, 1.0);
    } while ($running && $st === CURLM_OK);
    $out = [];
    foreach ($hs as $k => $ch) {
        $raw = (string)curl_multi_getcontent($ch);
        $out[$k] = [(int)curl_getinfo($ch, CURLINFO_HTTP_CODE), json_decode($raw, true), curl_error($ch)];
        curl_multi_remove_handle($mh, $ch);
        curl_close($ch);
    }
    curl_multi_close($mh);
    return $out;
}

function ai_text_of(?array $resp): string
{
    $t = '';
    foreach (($resp['candidates'][0]['content']['parts'] ?? []) as $p) {
        if (!empty($p['thought'])) continue;
        $t .= (string)($p['text'] ?? '');
    }
    return $t;
}

/**
 * Generates three design variants. Models are tried in order (config 'gemini_models'),
 * the next model is used when one is unknown or out of free quota.
 */
function ai_generate(array $company, string $prompt, string $tone, string $lang, string $length): array
{
    $system = ai_system_prompt($company, $tone, $lang, $length);
    $styles = ai_styles();
    $lastError = 'No Gemini model is configured.';

    foreach (cfg('gemini_models') as $model) {
        $url = rtrim(cfg('gemini_endpoint'), '/') . '/' . rawurlencode($model) . ':generateContent';
        $jobs = [];
        foreach ($styles as $i => $s) {
            $jobs[$i] = ['url' => $url, 'body' => json_encode([
                'systemInstruction' => ['parts' => [['text' => $system]]],
                'contents' => [['role' => 'user', 'parts' => [['text' => "What the newsletter is about:\n" . $prompt . "\n\nDesign direction: " . $s['name'] . ". " . $s['brief']]]]],
                'generationConfig' => ['temperature' => 0.9, 'maxOutputTokens' => 8192, 'responseMimeType' => 'application/json'],
            ], JSON_UNESCAPED_UNICODE)];
        }
        $res = ai_http_multi($jobs);

        $variants = [];
        $retryNext = true;
        foreach ($res as $i => [$status, $body, $err]) {
            if ($status === 200) {
                $v = ai_parse(ai_text_of($body));
                if ($v) { $variants[] = ['name' => $styles[$i]['name']] + $v; continue; }
                $lastError = 'Gemini answered, but the text was not a usable email. Try again.';
                continue;
            }
            $lastError = ai_error_message($status, $body ?: ['error' => ['message' => $err]]);
            if (in_array($status, [400, 401, 403], true)) $retryNext = false; // key problem: another model will not help
        }
        if ($variants) return ['variants' => $variants, 'model' => $model];
        if (!$retryNext) break;
    }
    throw new RuntimeException($lastError);
}
