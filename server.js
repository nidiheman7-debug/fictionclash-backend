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

const app = express();

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

// Render pings this (or you can point its health check here) to confirm
// the service is up.
app.get('/healthz', (req, res) => res.status(200).send('ok'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
  if (allowedOrigins.length === 0) {
    console.warn('CORS_ORIGIN is not set — browser requests from your frontend will be blocked.');
  }
});
