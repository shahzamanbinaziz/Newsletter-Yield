# MailHub, Hostinger (shared hosting) edition

Yeh version **PHP** mein hai, is liye Hostinger Premium/Business jaisi shared hosting par chalta hai. Koi VPS ya Node.js nahi chahiye. Sab kuch File Manager se hota hai.

```
Dashboard (browser)  ->  api.php        (login, companies, campaigns ...)
Email ke links/pixel ->  track.php      (opens, clicks, unsubscribe)
Cron job (har minute)->  cron.php       (queue se emails bhejta hai)
Database             ->  data/mailhub.sqlite  (ek file, khud ban jati hai)
```

## Pehle yeh 3 cheezein tayyar rakho
1. Ek **subdomain** (behtar) jaise `mail.yourdomain.com`, ya ek folder jaise `yourdomain.com/mail`.
2. Us par **SSL (https)** chalu ho (Hostinger mein free SSL milta hai, hPanel, Security, SSL).
3. hPanel, Advanced, **PHP Configuration**: PHP **8.1 ya naya** chuno, aur Extensions mein `pdo_sqlite`, `openssl`, `mbstring` on hon.

## Step 1: Subdomain banao (agar folder use karna ho to yeh chhod do)
hPanel, Domains, **Subdomains**, naam `mail` likho, Create. Hostinger iske liye ek folder bana deta hai (File Manager mein dikhega, jaise `public_html/mail` ya `domains/yourdomain.com/public_html/mail`).

## Step 2: Files upload karo
1. hPanel, **File Manager** kholo. Upar settings mein **"Show hidden files"** on karo (`.htaccess` file zaroori hai).
2. Subdomain ke folder mein jao.
3. `Hostinger-Upload.zip` upload karo, us par right click, **Extract**, phir zip delete kar do.
4. Check karo ke folder mein yeh sab hon: `index.html`, `api.php`, `track.php`, `cron.php`, `.htaccess`, `src/`, `data/`.

## Step 3: Settings bharo (config.php)
1. `config.sample.php` ko **Rename** karke `config.php` kar do.
2. Us par double click, **Edit**, aur yeh badlo:
   - `base_url`: `https://mail.yourdomain.com` (aakhir mein `/` nahi)
   - `secret`: 30+ lambe random akshar
   - `admin_email` aur `admin_password`: aap ka dashboard login
3. Save.

Jab tak `secret` aur `admin_password` nahi badlte, server login hi nahi karne deta. Yeh hifazat hai.

## Step 4: Dashboard kholo
`https://mail.yourdomain.com` kholo. Login karo. Agar login nahi hota to neeche "Masle" dekho.

## Step 5: Cron job lagao (yeh emails bhejta hai)
hPanel, Advanced, **Cron Jobs**:
- Type: **PHP**
- Command / file: `cron.php` ka poora path. File Manager mein `cron.php` par right click karo, path dikhta hai. Shakal kuch aisi hogi:
  `/home/u123456789/domains/yourdomain.com/public_html/mail/cron.php`
- Time: **har minute** (Every minute, `* * * * *`)

Yeh script ek minute chalti hai aur agle minute ki cron ko pakda hua kaam de deti hai. Ek saath do nahi chalti (lock hai).

**Agar hosting cron har minute nahi chalne deti:** `config.php` mein `cron_key` mein koi lamba text likho, phir free service cron-job.org par yeh address har minute kholne ka job banao:
`https://mail.yourdomain.com/cron.php?key=YOUR_CRON_KEY`

## Step 6: Pehla mailbox aur test
1. Dashboard, **Companies**, company banao, signature design karo.
2. **Mailboxes**, Add mailbox, Hostinger preset: host `smtp.hostinger.com`, port `465`, SSL on, username poora email. **Save and test connection**, "works" aana chahiye.
3. **Contacts**, kuch apne emails import karo (consent wala box tick karna padta hai).
4. **Campaigns**, naya campaign, **Send test**, phir sab ko schedule karo.
5. Cron chalne ke 1 minute ke andar emails jani shuru ho jati hain.

## Write with AI (Gemini, free)

Campaign editor mein **"Write with AI"** button: aap sirf likhte ho ke newsletter kis baare mein hai, aur AI **3 alag design** (Clean editorial, Bold announcement, Short personal note) bana deta hai. Pasand wala "Use this design" dabao, subject aur preview text bhi khud bhar jata hai.

**Ek baar setup:**
1. `aistudio.google.com/apikey` kholo (Google account se login), **Create API key**, key copy karo.
2. Hostinger File Manager mein `config.php` Edit karo, yeh line badlo:
   `'gemini_key' => 'YAHAN-APNI-KEY',`
3. Save karo, dashboard reload karo. Editor mein "Write with AI" button aa jayega.

**Dhyan rakho:**
- Free tier ki limits Google tay karta hai (AI Studio mein dikhti hain). Ek "Generate" 3 requests use karta hai. Limit poori ho to "free limit reached" likha aata hai, ek minute baad dobara karo.
- Model ke naam kabhi badal jate hain. Agar "model not found" aaye to `config.php` mein `'gemini_models' => ['naya-model-naam'],` ki line kholo. Naam yahan milte hain: `ai.google.dev/gemini-api/docs/models`. Pehla model fail ho to agla khud try hota hai.
- Jo likhoge woh Google ko jata hai. Customers ka private data prompt mein mat likho.
- AI facts ghalat likh sakta hai. Bhejne se pehle har number, date aur link khud check karo. `[date]` jaise bracket placeholders aur example links badlo.
- Key sirf `config.php` mein rehti hai, dashboard ya browser ko nazar nahi aati.

## Hosting ki hadein (zaroor parho)
- Shared hosting par har mailbox ki **daily/hourly sending limit** hoti hai (Hostinger ki apni). Dashboard mein mailbox ki `daily limit` us se **kam** rakho. Hostinger ki help page par aap ke plan ki limit dekh lo.
- Ek cron run mein ek mailbox ~ 1 email har `delay_seconds` bhejta hai. Default 5 sec, yaani lagbhag 10 email/minute/mailbox. Zyada mailboxes jodne se speed barhti hai.
- Open tracking andaza hai. Clicks zyada bharosemand hain.
- Hosting ka outbound SMTP port (465/587) khula hona chahiye. Aap ke apne Hostinger mailbox ke liye aam taur par khula hota hai.
- Domain ke DNS mein **SPF, DKIM, DMARC** zaroor hon (Hostinger email ke panel mein inke records milte hain).

## Masle aur hal
| Masla | Hal |
|---|---|
| Dashboard khulta hai lekin "Cannot reach the server" | `.htaccess` upload nahi hui (hidden files on karo), ya `https://mail.yourdomain.com/health` kholo: `{"ok":true}` aana chahiye |
| `/health` 404 deta hai | Hosting mein `.htaccess` rewrite band hai. Support se poocho ya PHP Configuration check karo |
| "set a new secret and admin_password" | `config.php` mein dono badlo |
| Login ke baad foran dobara login maangta hai | Host `Authorization` header hata raha hai. `.htaccess` ki pehli RewriteRule wali line mojood honi chahiye |
| Emails queue mein hain magar jaati nahi | Cron job check karo. Mailbox ka status "error" to nahi? Mailboxes page par test connection dabao |
| Mailbox "error" status | Password ghalat ya limit poori. Password theek karke Test dabao |
| Tracking links kaam nahi karte | `base_url` sahi https address hona chahiye |

## Hifazat
- `config.php`, `data/` aur `src/` web se band hain (`.htaccess`). Phir bhi behtar hai ke database ko `public_html` se **bahar** rakho: `config.php` mein `db_path` ki line khol kar `/home/u123.../mailhub-data/mailhub.sqlite` likho (folder File Manager mein banao).
- `config.php` ko GitHub par **kabhi** upload mat karo (`.gitignore` rokta hai).
- Backup: `data/mailhub.sqlite` ko haftay mein download kar lo.

## Update karna
Naye version ki files upload karo (`config.php` aur `data/` ko mat chhedo), purani files overwrite hone do.
