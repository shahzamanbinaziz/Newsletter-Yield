<?php
// The sender. Run it with a cron job every minute:
//    php /home/YOUR_USER/.../cron.php
// It keeps sending for about a minute, then stops. The next cron run continues.
//
// If your hosting cannot run PHP cron jobs, a free web cron service (cron-job.org) can open
//    https://YOUR-ADDRESS/cron.php?key=YOUR_CRON_KEY
// every minute instead. Set "cron_key" in config.php for that.
declare(strict_types=1);
require __DIR__ . '/src/bootstrap.php';

$seconds = cfg('cron_seconds');
if (PHP_SAPI !== 'cli') {
    $key = cfg('cron_key');
    if ($key === '' || !hash_equals($key, (string)($_GET['key'] ?? ''))) {
        http_response_code(403);
        echo 'Forbidden';
        exit;
    }
    @ignore_user_abort(true);
    @set_time_limit(0);
    $seconds = min($seconds, 25); // web requests are cut off sooner than cron jobs
    header('Content-Type: text/plain');
}
worker_run($seconds);
echo "done\n";
