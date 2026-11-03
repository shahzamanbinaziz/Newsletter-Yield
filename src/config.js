// Loads settings from environment variables (or a .env file next to package.json).
const fs = require('fs');
const path = require('path');

const envFile = path.join(__dirname, '..', '.env');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    if (line.trim().startsWith('#')) continue;
    const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  }
}

const e = process.env;
const port = Number(e.PORT) || 3000;

const config = {
  port,
  // Public address of THIS server. Tracking links and unsubscribe links in emails use it.
  baseUrl: (e.BASE_URL || `http://localhost:${port}`).replace(/\/+$/, ''),
  // Used to encrypt SMTP passwords and sign login tokens and tracking links.
  secret: e.APP_SECRET || 'dev-secret-change-me',
  adminEmail: (e.ADMIN_EMAIL || 'admin@example.com').toLowerCase().trim(),
  adminPassword: e.ADMIN_PASSWORD || 'change-me-now',
  // Comma separated list of dashboard origins allowed to call the API (needed for GitHub Pages).
  allowedOrigins: (e.ALLOWED_ORIGIN || '').split(',').map((s) => s.trim().replace(/\/+$/, '')).filter(Boolean),
  dbPath: path.resolve(e.DB_PATH || path.join(__dirname, '..', 'data', 'mailhub.db')),
  tickMs: Number(e.TICK_MS) || 1000,
  production: e.NODE_ENV === 'production',
};
config.insecure = config.secret === 'dev-secret-change-me' || config.adminPassword === 'change-me-now';

module.exports = config;
