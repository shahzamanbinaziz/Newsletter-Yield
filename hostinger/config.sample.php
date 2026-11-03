<?php
// 1. Copy this file and name the copy  config.php
// 2. Change the values below. Keep this file private (never upload config.php to GitHub).
return [
    // The https address where this dashboard lives, WITHOUT a slash at the end.
    // Examples:  'https://mail.yourcompany.com'   or   'https://yourcompany.com/mail'
    // Every tracking and unsubscribe link inside your emails starts with this address.
    'base_url' => 'https://mail.yourcompany.com',

    // A long random text. Encrypts your SMTP passwords and signs login and links.
    // Make one at https://www.random.org/strings/ (30+ characters) and never share it.
    'secret' => 'change-this-to-a-long-random-text',

    // Your dashboard login
    'admin_email' => 'you@yourcompany.com',
    'admin_password' => 'choose-a-strong-password',

    // Only if the dashboard is opened from another website, e.g. GitHub Pages:
    //   ['https://yourname.github.io']
    'allowed_origins' => [],

    // Only needed if you want to run cron through a web address (see cron.php):
    'cron_key' => '',

    // "Write with AI" in the campaign editor (Google Gemini, free tier).
    // 1. Open https://aistudio.google.com/apikey  2. Create API key  3. Paste it here.
    'gemini_key' => '',
    // Models are tried in this order (if the first is unknown or out of free quota, the next one is used).
    // Current names are listed at https://ai.google.dev/gemini-api/docs/models
    // 'gemini_models' => ['gemini-3.8-flash', 'gemini-3.5-flash-lite'],

    // Where the database file lives. The default (the data folder here) is protected by .htaccess.
    // For extra safety use a folder ABOVE public_html, e.g. '/home/u123456789/mailhub-data/mailhub.sqlite'
    // 'db_path' => '/home/u123456789/mailhub-data/mailhub.sqlite',
];
