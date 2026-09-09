// server.js — entry point for Render.
//
// Render runs one long-lived Node process (unlike Vercel, which ran each
// /api/*.js file as its own short-lived function). This file routes
// requests to the same handler functions you already had, unchanged in
// logic, plus CORS for the routes your frontend calls directly from the
// browser.
//
// IMPORTANT ORDERING: the Paystack webhook route is mounted BEFORE
// express.json(), so its request body arrives as an untouched raw
// stream — paystack-webhook.js reads that itself and needs the exact
// raw bytes to verify Paystack's HMAC signature. Every other route is
// mounted AFTER express.json(), so req.body is already a parsed object,
// matching how Vercel behaved for these same handlers.
//
// CORS is intentionally NOT applied to /api/paystack-webhook — that
// route is called server-to-server by Paystack, never by a browser, so
// it doesn't need (or want) CORS headers.

import express from 'express';
import cors from 'cors';
import createPaymentHandler from './api/create-payment.js';
import verifyPaymentHandler from './api/verify-payment.js';
import paystackWebhookHandler from './api/paystack-webhook.js';
import likeHandler from './api/like.js';

const app = express();

// Logs every incoming request BEFORE any routing/CORS logic runs, so we
// can see in Render's logs exactly what's arriving (method, path, and
// the browser's Origin header) — including preflight OPTIONS requests
// and anything CORS ends up rejecting. Without this, a CORS rejection
// happens silently: the request arrives, gets turned away, and nothing
// is ever printed, which makes it look like nothing reached the server
// at all.
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    console.log(
      `${req.method} ${req.path} -> ${res.statusCode} (${Date.now() - start}ms)`
      + ` Origin: ${req.headers.origin || 'none'}`
    );
  });
  next();
});

// Comma-separated list of allowed frontend origins, e.g.
// "https://your-app.vercel.app,https://yourdomain.com"
// Set this in Render's environment variables — do NOT hardcode it here,
// since it'll likely differ between staging and production.
const allowedOrigins = (process.env.CORS_ORIGIN || '')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);

const corsOptions = {
  origin(origin, callback) {
    // Allow server-to-server calls / curl / health checks (no Origin
    // header at all), and any origin explicitly listed above.
    if (!origin || allowedOrigins.includes(origin)) {
      return callback(null, true);
    }
    return callback(new Error(`Origin ${origin} not allowed by CORS`));
  },
  methods: ['POST'],
  allowedHeaders: ['Content-Type', 'Authorization'],
};

// --- Raw-body route (must come first, no CORS) ---
app.post('/api/paystack-webhook', paystackWebhookHandler);

// --- JSON body-parsing + CORS for browser-facing routes ---
app.use(express.json());

app.post('/api/create-payment', cors(corsOptions), createPaymentHandler);
app.post('/api/verify-payment', cors(corsOptions), verifyPaymentHandler);
app.post('/api/like', cors(corsOptions), likeHandler);

// Browsers send an OPTIONS preflight before the actual POST for these
// routes (cross-origin + JSON body + Authorization header always
// triggers one). Without an explicit OPTIONS route, Express returns 404
// to the preflight and the browser blocks the real request entirely —
// this is what was causing "Could not start checkout" on the frontend.
app.options('/api/create-payment', cors(corsOptions));
app.options('/api/verify-payment', cors(corsOptions));
app.options('/api/like', cors(corsOptions));

// Render pings this (or you can point its health check here) to confirm
// the service is up.
app.get('/healthz', (req, res) => res.status(200).send('ok'));

// Catches the error thrown by corsOptions.origin() above when a request
// comes from an origin not in CORS_ORIGIN. Without this handler, Express's
// default error handler would return a generic HTML 500 with no CORS
// headers, which looks identical to a network failure in the browser —
// this makes the actual reason visible in the logs instead.
app.use((err, req, res, next) => {
  if (err && err.message && err.message.includes('not allowed by CORS')) {
    console.error('CORS rejection:', err.message);
    return res.status(403).json({ error: 'Origin not allowed' });
  }
  console.error('Unhandled error:', err);
  return res.status(500).json({ error: 'Internal server error' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
  if (allowedOrigins.length === 0) {
    console.warn('CORS_ORIGIN is not set — browser requests from your frontend will be blocked.');
  }
});
