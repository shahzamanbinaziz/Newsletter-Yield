# MailHub

Apna khud ka newsletter platform. Aap company ke mailboxes (Hostinger, Google Workspace, Microsoft 365, cPanel, kuch bhi) ka **SMTP** use karte ho, aur MailHub dashboard, campaigns, tracking aur har company ki signature sambhalta hai.

## Kya kya hai

| Feature | Detail |
|---|---|
| **Companies** | Har company ke alag contacts, mailboxes, campaigns aur signature |
| **Mailboxes** | SMTP host/port/password (database mein encrypted), daily limit, warm-up, connection test |
| **Contacts** | CSV import, lists, consent record, unsubscribed/bounced log hamesha suppressed |
| **Campaigns** | HTML editor, live preview, test email, schedule ya abhi send, pause/resume |
| **Tracking** | Opens, clicks (per link), unsubscribes, failures, per-recipient report |
| **Signature designer** | 3 designs, live preview, har email mein khud lagti hai, HTML copy karke Gmail/Outlook mein bhi |
| **Deliverability** | One-click unsubscribe header, plain-text version, slow sending, daily limits |

## Hostinger shared hosting? Use the PHP edition

Agar aap ke paas sirf Hostinger Premium/Business web hosting hai (Node.js nahi), to **`hostinger/`** folder use karo. Wohi dashboard aur features, magar backend PHP mein, emails cron job se jati hain. Poori guide: [`hostinger/README_HOSTINGER.md`](hostinger/README_HOSTINGER.md).

Is README ke baqi steps **Node.js edition** (VPS / Railway) ke hain.

## Do hisson ka system

```
public/   -> Dashboard (sirf HTML/CSS/JS). GitHub Pages pe ja sakta hai.
server.js
src/      -> Backend (Node.js). SMTP se emails bhejta hai, tracking links serve karta hai.
              Yeh GitHub Pages pe NAHI chal sakta. Is ke liye ek chhota server (VPS) chahiye.
```

GitHub sirf code rakhta hai aur dashboard dikha sakta hai. Emails bhejne wala hissa hamesha ek server pe chalega.

---

## Step 1: Apne computer pe chalao (test ke liye)

1. Node.js 20 ya naya install karo (nodejs.org).
2. Is folder mein terminal kholo:
   ```
   npm install
   cp .env.example .env        (Windows: copy .env.example .env)
   npm start
   ```
3. Browser mein `http://localhost:3000` kholo.
4. Login: `.env` mein jo `ADMIN_EMAIL` aur `ADMIN_PASSWORD` rakha woh.
   (Agar `.env` nahi banaya to `admin@example.com` / `change-me-now`. Yeh sirf test ke liye hai.)

Test chalane ke liye: `npm test` (ek nakli SMTP server ke saath poora flow check karta hai).

> Localhost pe bheji hui email ke tracking links sirf aap ke computer pe khulte hain. Asli tracking ke liye Step 2 zaroori hai.

## Step 2: Server pe lagao (asli use)

Ek chhota Linux VPS chahiye (Ubuntu 22.04 ya 24.04). Hostinger VPS, DigitalOcean, Hetzner, Contabo, sab chalte hain. Aur ek domain/subdomain, jaise `mail.yourcompany.com`, jo VPS ke IP ki taraf point kare (DNS mein **A record**).

Note: kuch providers SMTP ports block karte hain. Agar emails na jayein to provider ki support se poochho ke port 465/587 khula hai ya nahi.

```bash
# 1. Node.js 22 install
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs git

# 2. Code lao
git clone https://github.com/YOURNAME/mailhub.git
cd mailhub
npm install --omit=dev

# 3. Settings
cp .env.example .env
nano .env        # BASE_URL, APP_SECRET, ADMIN_EMAIL, ADMIN_PASSWORD bharo
                 # APP_SECRET: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

# 4. Hamesha chalta rahe (restart pe bhi)
sudo npm install -g pm2
pm2 start server.js --name mailhub
pm2 save
pm2 startup      # jo command dikhaye woh chalao

# 5. HTTPS (Caddy khud certificate le leta hai)
sudo apt-get install -y caddy
```

`/etc/caddy/Caddyfile` mein yeh likho (domain apna daalo):

```
mail.yourcompany.com {
    reverse_proxy localhost:3000
}
```

Phir `sudo systemctl reload caddy`. Ab `https://mail.yourcompany.com` pe dashboard khulna chahiye.

**Backup:** Poora data ek file mein hai: `data/mailhub.db`. Isay roz kisi dusri jagah copy karo.

**Update karna:** `git pull && npm install --omit=dev && pm2 restart mailhub`

## Step 3: (Optional) Dashboard GitHub Pages pe

Server pe dashboard pehle se khulta hai, to Pages zaroori nahi. Agar chaho:

1. Code GitHub repo mein push karo (**`.env` aur `data/` kabhi nahi**, `.gitignore` inhe rok deta hai).
2. Repo, Settings, Pages, Source: **GitHub Actions**. Is repo mein `.github/workflows/pages.yml` pehle se hai.
3. `public/config.js` mein `API_BASE: 'https://mail.yourcompany.com'` likho aur push karo.
4. Server ki `.env` mein `ALLOWED_ORIGIN=https://YOURNAME.github.io` likho aur `pm2 restart mailhub`.

> Repo **private** rakho. Dashboard khud password se bandh hai, lekin code private rakhna behtar hai.

## Step 4: Pehla mailbox jodo

Dashboard, **Mailboxes, Add mailbox**. Provider chuno, baki khud bhar jata hai:

| Provider | SMTP host | Port |
|---|---|---|
| Hostinger Email | `smtp.hostinger.com` | 465 (SSL) |
| Google Workspace | `smtp.gmail.com` | 465 (SSL), app password chahiye ho sakta hai |
| Microsoft 365 | `smtp.office365.com` | 587 (STARTTLS), admin ko SMTP on karna pad sakta hai |
| Zoho Mail | `smtp.zoho.com` | 465 (SSL) |
| cPanel / apna host | `mail.yourdomain.com` | 465 ya 587 |

Yeh values apne host ki help page se confirm kar lo. Username aam taur par poora email address hota hai. "Save and test connection" dabao: agar "connection works" aaye to ho gaya.

## Step 5: DNS (emails spam mein na jayein)

Jis domain se email jati hai uske DNS mein **SPF, DKIM, DMARC** hone chahiye. Hostinger/Google/Microsoft ke panel mein inke exact records milte hain. Inke bina Gmail aur Yahoo aap ki emails spam mein daal denge. Check karne ke liye mail-tester.com pe ek test email bhejo.

## Step 6: Pehla campaign

1. **Companies**: company ka naam, logo URL, rang aur **signature design** karo.
2. **Contacts, Import contacts**: sirf unhein jinhon ne signup kiya ya jo aap se asli taur pe opt-in hain.
3. **Campaigns, New campaign**: subject, content (starter template use kar sakte ho), list, mailbox.
4. **Send test** apne aap ko bhejo, inbox aur spam dono dekho.
5. **Schedule or send**.
6. Campaign ke report page pe opens, clicks, unsubscribes live dekho.

## Zimmedar istemal (yeh platform ki bunyad hai)

- Sirf unhein email bhejo jinhon ne ijazat di. Import karte waqt MailHub consent ka source aur tareekh save karta hai.
- Har email mein unsubscribe link hota hai (aur Gmail/Yahoo ka one-click header). Unsubscribe ya bounce hone wala contact dobara import nahi ho sakta aur delete bhi nahi.
- Daily limit aur warm-up mailbox ki reputation bachate hain. Inhe bypass karne ki koshish na karo.
- Kai mailboxes ka istemal sirf limits baantne ke liye hai, spam filters se bachne ke liye nahi.
- Apne mulk/region ke email qawaneen dekho (CAN-SPAM, GDPR, PECR waghera). Footer mein postal address zaroor rakho.

## Tracking kaise kaam karta hai (aur uski hadd)

- **Click:** har link MailHub ke server se guzar kar asli page pe jata hai. Links signed hain, koi dusre ko redirect nahi kar sakta.
- **Open:** email mein 1x1 chhoti image hoti hai. Apple Mail jaisi apps images pehle se load kar leti hain aur kuch apps block karti hain, to **open rate andaza hai**. Click aur reply zyada sachche signals hain.
- Security scanners (Defender, Proofpoint waghera) links khol dete hain. Inhe pehchaan kar ignore kiya jata hai, lekin har scanner pakda nahi jata.

## Abhi shamil nahi (agle qadam)

- Bounce emails ko IMAP se padhna (abhi sirf wahi bounce pakde jate hain jo SMTP server turant reject kare).
- Drag and drop email builder (abhi HTML + starter templates).
- Multiple login users aur roles (abhi ek admin).
- Signup form jo website pe lag sake (public subscribe endpoint).
- A/B subject test, automation sequences (welcome series).

## Files

```
server.js         Express server, CORS, error handling
src/config.js     .env padhta hai
src/db.js         SQLite tables
src/api.js        Dashboard API (login, companies, mailboxes, contacts, campaigns, stats)
src/track.js      Open pixel, click redirect, unsubscribe page
src/worker.js     Queue: har second mailbox ke hisaab se agli email bhejta hai
src/mailer.js     Email banana (personalise, links track, footer, signature) aur SMTP se bhejna
src/signature.js  Signature designs
public/           Dashboard
test/e2e.js       Poora flow test (nakli SMTP ke saath)
```
