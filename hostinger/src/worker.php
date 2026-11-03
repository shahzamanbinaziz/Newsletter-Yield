<?php
// The sender. cron.php runs it every minute. Each pass ("tick"):
//  1. starts campaigns that are due (creates one queued message per active contact)
//  2. lets each mailbox send ONE email if its delay has passed and its daily limit is not reached
//  3. marks campaigns as sent when nothing is left in the queue
declare(strict_types=1);

function launch_campaign(array $c): void
{
    $pdo = db();
    $pdo->beginTransaction();
    try {
        $ids = array_map('intval', parse_json_or($c['mailbox_ids'], []));
        $mbs = [];
        if ($ids) {
            $in = implode(',', array_fill(0, count($ids), '?'));
            $mbs = many("SELECT id FROM mailboxes WHERE company_id=? AND status='active' AND id IN ($in)", array_merge([$c['company_id']], $ids));
        }
        if (!$c['list_id'] || !$mbs) {
            run("UPDATE campaigns SET status='failed', note=? WHERE id=?", [!$c['list_id'] ? 'No list selected.' : 'No active mailbox selected.', $c['id']]);
        } else {
            $contacts = many("SELECT c.id FROM contacts c JOIN list_contacts lc ON lc.contact_id=c.id
                WHERE lc.list_id=? AND c.company_id=? AND c.status='active' ORDER BY c.id", [$c['list_id'], $c['company_id']]);
            foreach ($contacts as $i => $ct) {
                run('INSERT INTO messages(campaign_id,contact_id,mailbox_id,token,created_at) VALUES(?,?,?,?,?)',
                    [$c['id'], $ct['id'], $mbs[$i % count($mbs)]['id'], random_token(), now()]);
            }
            if ($contacts) {
                run("UPDATE campaigns SET status='sending', started_at=?, note='' WHERE id=?", [now(), $c['id']]);
            } else {
                run("UPDATE campaigns SET status='sent', started_at=?, finished_at=?, note='List had no active contacts.' WHERE id=?", [now(), now(), $c['id']]);
            }
        }
        $pdo->commit();
    } catch (Throwable $e) {
        $pdo->rollBack();
        throw $e;
    }
}

function send_next(array $mb): void
{
    if (microtime(true) < (float)$mb['next_send_ts']) return;

    if ($mb['sent_date'] !== today()) {
        run('UPDATE mailboxes SET sent_date=?, sent_today=0 WHERE id=?', [today(), $mb['id']]);
        $mb['sent_today'] = 0;
    }
    if ((int)$mb['sent_today'] >= effective_limit($mb)) return; // continues tomorrow

    $msg = one("SELECT m.* FROM messages m JOIN campaigns c ON c.id=m.campaign_id
        WHERE m.mailbox_id=? AND m.status='queued' AND c.status='sending' ORDER BY m.id LIMIT 1", [$mb['id']]);
    if (!$msg) return;

    $gap = (int)$mb['delay_seconds'] * (1 + mt_rand(0, 400) / 1000); // small random jitter looks natural
    run('UPDATE mailboxes SET next_send_ts=? WHERE id=?', [microtime(true) + $gap, $mb['id']]);

    $campaign = one('SELECT * FROM campaigns WHERE id=?', [$msg['campaign_id']]);
    $contact = one('SELECT * FROM contacts WHERE id=?', [$msg['contact_id']]);
    $company = one('SELECT * FROM companies WHERE id=?', [$campaign['company_id']]);

    // Someone may have unsubscribed after the campaign was queued.
    if ($contact['status'] !== 'active') {
        run("UPDATE messages SET status='skipped', error=? WHERE id=?", ['Contact is ' . $contact['status'], $msg['id']]);
        return;
    }

    try {
        $built = build_email($campaign, $contact, $company, $mb, $msg, true);
        smtp_send_mail($mb, $contact['email'], $built);
        run("UPDATE messages SET status='sent', sent_at=?, error='' WHERE id=?", [now(), $msg['id']]);
        run('UPDATE mailboxes SET sent_today=sent_today+1, sent_date=? WHERE id=?', [today(), $mb['id']]);
    } catch (Throwable $err) {
        handle_send_error($mb, $msg, $contact, $err);
    }
}

function handle_send_error(array $mb, array $msg, array $contact, Throwable $err): void
{
    $smtp = $err instanceof SmtpError ? $err : null;
    $text = mb_substr($smtp ? $smtp->response : $err->getMessage(), 0, 300);
    $code = $smtp ? $smtp->smtpCode : 0;

    // Wrong password or provider says the sending limit is reached: pause the mailbox, keep messages queued.
    if (($smtp && $smtp->kind === 'auth') || (preg_match('/quota|limit exceeded|too many|rate limit|daily/i', $text) && $code >= 400)) {
        run("UPDATE mailboxes SET status='error', last_error=? WHERE id=?", [$text, $mb['id']]);
        return;
    }
    // Recipient address rejected permanently: do not retry, stop mailing this contact.
    if ($smtp && $smtp->command === 'RCPT TO' && $code >= 500) {
        run("UPDATE messages SET status='failed', error=? WHERE id=?", [$text, $msg['id']]);
        if (in_array($code, [550, 551, 553, 554], true)) run("UPDATE contacts SET status='bounced' WHERE id=?", [$contact['id']]);
        return;
    }
    // Anything else (timeouts, temporary errors): retry up to 3 times.
    $attempts = (int)$msg['attempts'] + 1;
    if ($attempts >= 3) {
        run("UPDATE messages SET status='failed', attempts=?, error=? WHERE id=?", [$attempts, $text, $msg['id']]);
    } else {
        run('UPDATE messages SET attempts=?, error=? WHERE id=?', [$attempts, $text, $msg['id']]);
        run('UPDATE mailboxes SET next_send_ts=? WHERE id=?', [microtime(true) + 60, $mb['id']]);
    }
}

function worker_tick(): void
{
    foreach (many("SELECT * FROM campaigns WHERE status='scheduled' AND scheduled_at<=?", [now()]) as $c) launch_campaign($c);

    $mbs = many("SELECT * FROM mailboxes WHERE status='active' AND id IN (
        SELECT m.mailbox_id FROM messages m JOIN campaigns c ON c.id=m.campaign_id WHERE m.status='queued' AND c.status='sending')");
    foreach ($mbs as $mb) send_next($mb);

    run("UPDATE campaigns SET status='sent', finished_at=? WHERE status='sending'
        AND NOT EXISTS (SELECT 1 FROM messages WHERE campaign_id=campaigns.id AND status='queued')", [now()]);
}

/** Keeps ticking for $seconds, then stops. Cron starts it again every minute. */
function worker_run(int $seconds): void
{
    $lock = @fopen(MH_ROOT . '/data/cron.lock', 'c');
    if (!$lock || !flock($lock, LOCK_EX | LOCK_NB)) return; // the previous run is still busy
    if (base_url() === '') {
        fwrite(STDERR, "base_url is empty. Set it in config.php (your https address), otherwise tracking links cannot work.\n");
        return;
    }
    $end = microtime(true) + $seconds;
    $tick = max(200, cfg('tick_ms')) * 1000;
    do {
        try {
            worker_tick();
        } catch (Throwable $e) {
            error_log('MailHub worker error: ' . $e->getMessage());
        }
        if (microtime(true) >= $end) break;
        usleep($tick);
    } while (microtime(true) < $end);
    flock($lock, LOCK_UN);
}
