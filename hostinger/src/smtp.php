<?php
// A small SMTP client (no libraries needed, so it works on any shared hosting).
// Supports SSL (port 465), STARTTLS (port 587), AUTH PLAIN / LOGIN, HTML + plain text emails.
declare(strict_types=1);

class SmtpError extends Exception
{
    public string $command = '';
    public string $response = '';
    public int $smtpCode = 0;
    /** 'auth' = login refused, 'net' = connection problem, 'smtp' = server said no */
    public string $kind = 'smtp';

    public static function make(string $kind, string $message, string $command = '', int $code = 0, string $response = ''): self
    {
        $e = new self($message);
        $e->kind = $kind;
        $e->command = $command;
        $e->smtpCode = $code;
        $e->response = $response !== '' ? $response : $message;
        return $e;
    }
}

final class SmtpClient
{
    /** @var resource|null */
    private $fp = null;

    public function __construct(private array $mb, private string $password) {}

    public function open(): void
    {
        $secure = !empty($this->mb['secure']);
        $host = (string)$this->mb['host'];
        $port = (int)$this->mb['port'];
        $selfSigned = cfg('allow_self_signed');
        $ctx = stream_context_create(['ssl' => [
            'verify_peer' => !$selfSigned, 'verify_peer_name' => !$selfSigned,
            'allow_self_signed' => $selfSigned, 'SNI_enabled' => true, 'peer_name' => $host,
        ]]);
        $fp = @stream_socket_client(($secure ? 'ssl://' : 'tcp://') . $host . ':' . $port, $errno, $errstr, 15, STREAM_CLIENT_CONNECT, $ctx);
        if (!$fp) throw SmtpError::make('net', "Cannot connect to $host:$port ($errstr). Check the host, the port and the SSL setting.");
        $this->fp = $fp;
        stream_set_timeout($fp, 30);

        $this->expect([220], 'CONNECT');
        $ehlo = $this->cmd('EHLO ' . $this->myName(), [250]);

        if (!$secure && stripos($ehlo, 'STARTTLS') !== false) {
            $this->cmd('STARTTLS', [220]);
            $method = STREAM_CRYPTO_METHOD_TLS_CLIENT;
            if (defined('STREAM_CRYPTO_METHOD_TLSv1_2_CLIENT')) $method |= STREAM_CRYPTO_METHOD_TLSv1_2_CLIENT;
            if (defined('STREAM_CRYPTO_METHOD_TLSv1_3_CLIENT')) $method |= STREAM_CRYPTO_METHOD_TLSv1_3_CLIENT;
            if (!@stream_socket_enable_crypto($fp, true, $method)) throw SmtpError::make('net', 'Could not start a secure (TLS) connection with the mail server.');
            $ehlo = $this->cmd('EHLO ' . $this->myName(), [250]);
        }

        $user = (string)$this->mb['username'];
        if ($user !== '' && preg_match('/\bAUTH\b/i', $ehlo)) {
            try {
                if (preg_match('/AUTH[^\n]*\bPLAIN\b/i', $ehlo)) {
                    $this->cmd('AUTH PLAIN ' . base64_encode("\0" . $user . "\0" . $this->password), [235], 'AUTH');
                } else {
                    $this->cmd('AUTH LOGIN', [334], 'AUTH');
                    $this->cmd(base64_encode($user), [334], 'AUTH');
                    $this->cmd(base64_encode($this->password), [235], 'AUTH');
                }
            } catch (SmtpError $e) {
                if ($e->kind === 'smtp') $e->kind = 'auth';
                throw $e;
            }
        }
    }

    public function send(string $from, string $to, string $rawMessage): void
    {
        $this->cmd('MAIL FROM:<' . $from . '>', [250], 'MAIL FROM');
        $this->cmd('RCPT TO:<' . $to . '>', [250, 251], 'RCPT TO');
        $this->cmd('DATA', [354], 'DATA');
        $data = preg_replace('/^\./m', '..', $rawMessage);
        $this->write($data . "\r\n.\r\n");
        $this->expect([250], 'DATA');
    }

    public function close(): void
    {
        if ($this->fp) {
            @fwrite($this->fp, "QUIT\r\n");
            @fclose($this->fp);
            $this->fp = null;
        }
    }

    private function myName(): string
    {
        $h = parse_url(base_url(), PHP_URL_HOST) ?: ($_SERVER['SERVER_NAME'] ?? 'localhost');
        return preg_match('/^[A-Za-z0-9.-]+$/', (string)$h) ? (string)$h : 'localhost';
    }

    private function write(string $s): void
    {
        if (@fwrite($this->fp, $s) === false) throw SmtpError::make('net', 'Connection to the mail server was lost.');
    }

    private function cmd(string $line, array $ok, string $label = ''): string
    {
        $this->write($line . "\r\n");
        return $this->expect($ok, $label !== '' ? $label : strtok($line, ' '));
    }

    private function expect(array $ok, string $label): string
    {
        $lines = [];
        while (true) {
            $l = fgets($this->fp, 8192);
            if ($l === false) {
                $meta = stream_get_meta_data($this->fp);
                throw SmtpError::make('net', !empty($meta['timed_out']) ? 'The mail server took too long to answer.' : 'Connection to the mail server was lost.', $label);
            }
            $lines[] = rtrim($l, "\r\n");
            if (strlen($l) < 4 || $l[3] !== '-') break;
        }
        $code = (int)substr(end($lines), 0, 3);
        $text = implode("\n", $lines);
        if (!in_array($code, $ok, true)) throw SmtpError::make('smtp', $text, $label, $code, $text);
        return $text;
    }
}

/** Opens a connection, runs $fn($client), always closes. */
function smtp_session(array $mb, callable $fn)
{
    $c = new SmtpClient($mb, decrypt_text((string)$mb['password_enc']));
    try {
        $c->open();
        return $fn($c);
    } finally {
        $c->close();
    }
}

/* ---- building the raw message ---- */

function mime_header(string $s): string
{
    $s = preg_replace('/[\r\n]+/', ' ', $s);
    return preg_match('/[^\x20-\x7E]/', $s) ? '=?UTF-8?B?' . base64_encode($s) . '?=' : $s;
}
function mime_address(string $name, string $email): string
{
    $name = preg_replace('/[\r\n]+/', ' ', $name);
    $email = preg_replace('/[\r\n<>]+/', '', $email);
    if ($name === '') return '<' . $email . '>';
    if (preg_match('/[^\x20-\x7E]/', $name)) return '=?UTF-8?B?' . base64_encode($name) . '?= <' . $email . '>';
    return '"' . str_replace(['\\', '"'], ['\\\\', '\\"'], $name) . '" <' . $email . '>';
}
function qp(string $s): string
{
    $s = str_replace(["\r\n", "\r"], "\n", $s);
    return quoted_printable_encode(str_replace("\n", "\r\n", $s));
}

function build_raw_message(array $mb, string $to, array $built): string
{
    $domain = substr(strrchr((string)$mb['from_email'], '@') ?: '@localhost', 1);
    $boundary = '=_mh_' . bin2hex(random_bytes(12));
    $h = [
        'Date: ' . gmdate('D, d M Y H:i:s') . ' +0000',
        'From: ' . mime_address((string)$mb['from_name'], (string)$mb['from_email']),
        'To: <' . preg_replace('/[\r\n<>]+/', '', $to) . '>',
        'Subject: ' . mime_header((string)$built['subject']),
        'Message-ID: <' . bin2hex(random_bytes(12)) . '@' . $domain . '>',
        'MIME-Version: 1.0',
    ];
    foreach ($built['headers'] as $k => $v) $h[] = $k . ': ' . preg_replace('/[\r\n]+/', ' ', (string)$v);
    $h[] = 'Content-Type: multipart/alternative; boundary="' . $boundary . '"';

    $body = '--' . $boundary . "\r\n"
        . "Content-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\n" . qp((string)$built['text']) . "\r\n"
        . '--' . $boundary . "\r\n"
        . "Content-Type: text/html; charset=utf-8\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\n" . qp((string)$built['html']) . "\r\n"
        . '--' . $boundary . "--";
    return implode("\r\n", $h) . "\r\n\r\n" . $body;
}

function smtp_send_mail(array $mb, string $to, array $built): void
{
    $raw = build_raw_message($mb, $to, $built);
    smtp_session($mb, fn(SmtpClient $c) => $c->send((string)$mb['from_email'], $to, $raw));
}

function smtp_verify(array $mb): void
{
    smtp_session($mb, fn(SmtpClient $c) => true);
}
