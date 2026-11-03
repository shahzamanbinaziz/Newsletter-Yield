<?php
// Only for local testing with PHP's built-in server:  php -S 127.0.0.1:8080 dev-router.php
// (On real hosting the .htaccess file does this job.)
$path = parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH);
if ($path === '/health' || str_starts_with($path, '/api')) { require __DIR__ . '/api.php'; return true; }
if (str_starts_with($path, '/t/')) { require __DIR__ . '/track.php'; return true; }
return false;
