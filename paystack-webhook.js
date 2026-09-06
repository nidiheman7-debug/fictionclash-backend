// /api/paystack-webhook.js
// Paystack calls this directly after a transaction completes — set the
// webhook URL to https://<your-domain>/api/paystack-webhook in the
// Paystack dashboard (Settings > API Keys & Webhooks). This is the
// authoritative fulfillment path: verify-payment.js only exists so the
// UI can react immediately, but a user closing the app right after paying
// (before that call fires) would otherwise never get their item — this
// webhook is what covers that case. Requires the same
// FIREBASE_SERVICE_ACCOUNT_KEY env var as vote.js, plus
// PAYSTACK_SECRET_KEY (used both to call Paystack's verify endpoint and
// to check the webhook's signature).
//
// Body parsing is turned off so the signature can be checked against the
// exact raw bytes Paystack sent — parsing and re-stringifying JSON can
// change whitespace/key order and break the HMAC check.

import crypto from 'crypto';
import admin from 'firebase-admin';
import { creditPayment } from './verify-payment.js';

// No `config.api.bodyParser` export here anymore — that was a Vercel/
// Next.js-only directive and has no effect on Render. Raw-body handling
// is instead controlled in server.js, by mounting this route BEFORE any
// JSON body-parsing middleware. The readRawBody() function below is
// unchanged and still does the actual work.

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(
      JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_KEY)
    ),
  });
}

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const rawBody = await readRawBody(req);
  const signature = req.headers['x-paystack-signature'];
  const expectedSignature = crypto
    .createHmac('sha512', process.env.PAYSTACK_SECRET_KEY)
    .update(rawBody)
    .digest('hex');

  if (!signature || signature !== expectedSignature) {
    // Not a genuine Paystack call — do not process it, and do not leak
    // which part of the check failed.
    return res.status(401).json({ error: 'Invalid signature' });
  }

  let event;
  try {
    event = JSON.parse(rawBody.toString('utf8'));
  } catch (err) {
    return res.status(400).json({ error: 'Invalid payload' });
  }

  // Only charge.success is relevant — other events (transfer, subscription,
  // etc.) aren't used by this app.
  if (event.event !== 'charge.success') {
    return res.status(200).json({ received: true, ignored: true });
  }

  const reference = event.data?.reference;
  if (!reference) {
    return res.status(200).json({ received: true, ignored: true });
  }

  try {
    // Reuses the exact same crediting logic verify-payment.js uses, so a
    // payment credited by one path is simply a no-op ("alreadyCredited")
    // when the other path runs too.
    await creditPayment(reference);
    return res.status(200).json({ received: true });
  } catch (err) {
    console.error('Webhook credit failed:', err);
    // 200 even on our own processing error so Paystack doesn't retry into
    // a broken state indefinitely — the "unknown-reference" case in
    // particular can never succeed on retry, and a real transient error
    // gets caught by the fact that verify-payment.js still runs on
    // client return. Logged above for visibility either way.
    return res.status(200).json({ received: true, error: 'processing-error' });
  }
}
