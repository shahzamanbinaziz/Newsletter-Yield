const path = require('path');
const express = require('express');
const config = require('./src/config');
require('./src/db');
const worker = require('./src/worker');

if (config.insecure && config.production) {
  console.error('Refusing to start: set APP_SECRET and ADMIN_PASSWORD in your .env file first.');
  process.exit(1);
}

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);

app.use((req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Referrer-Policy', 'no-referrer');
  next();
});

// CORS is only needed when the dashboard is hosted elsewhere (for example GitHub Pages).
app.use('/api', (req, res, next) => {
  const origin = req.get('origin');
  if (origin && config.allowedOrigins.includes(origin.replace(/\/+$/, ''))) {
    res.set('Access-Control-Allow-Origin', origin);
    res.set('Vary', 'Origin');
    res.set('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    res.set('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.get('/health', (req, res) => res.json({ ok: true }));
app.use(require('./src/track'));
app.use('/api', express.json({ limit: '10mb' }), require('./src/api'));
app.use(express.static(path.join(__dirname, 'public')));

app.use((err, req, res, next) => {
  const status = err.status || (err.type === 'entity.parse.failed' ? 400 : 500);
  if (status >= 500) console.error(err);
  res.status(status).json({ error: status >= 500 ? 'Something went wrong on the server.' : err.message });
});

app.listen(config.port, () => {
  console.log(`MailHub running at ${config.baseUrl} (port ${config.port})`);
  if (config.insecure) console.warn('WARNING: using default APP_SECRET / ADMIN_PASSWORD. Fine for testing, never for production.');
  worker.start();
});
