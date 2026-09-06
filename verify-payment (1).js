// /api/verify-payment.js
// Called by the client right after returning from Paystack checkout, so
// the UI can unlock the item and show a result immediately instead of
// waiting on the webhook. This is a convenience path only — it does its
// own independent check against Paystack's API (never trusts the client's
// "it worked" claim), and paystack-webhook.js does the same crediting
// logic as a background safety net for anyone who closes the app before
// this call finishes. Both paths are idempotent: the payment doc's
// `status` field guards against double-crediting no matter which one
// (or both) fires.
// Requires the same FIREBASE_SERVICE_ACCOUNT_KEY env var as vote.js, plus
// PAYSTACK_SECRET_KEY.

import admin from 'firebase-admin';
import { BADGE_RENEWAL_DAYS } from './lib/pricing.js';

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(
      JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_KEY)
    ),
  });
}

const db = admin.firestore();

export async function creditPayment(reference) {
  // Shared by verify-payment.js and paystack-webhook.js so both paths
  // credit the item exactly the same way. Returns the payment doc's
  // resulting state; throws only on unexpected errors (never on
  // "already credited", which is the expected steady state once either
  // path has already run).
  const paymentRef = db.collection('payments').doc(reference);

  const paystackResp = await fetch(`https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`, {
    headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}` },
  });
  const paystackData = await paystackResp.json();
  const tx = paystackData?.data;

  return db.runTransaction(async (trx) => {
    const snap = await trx.get(paymentRef);
    if (!snap.exists) throw new Error('unknown-reference');
    const payment = snap.data();

    if (payment.status === 'success') {
      return { alreadyCredited: true, payment };
    }

    const paidOk = paystackResp.ok
      && tx
      && tx.status === 'success'
      && tx.currency === 'NGN'
      && tx.amount === payment.amountKobo;

    if (!paidOk) {
      trx.set(paymentRef, {
        status: 'failed',
        verifiedAt: admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });
      return { alreadyCredited: false, payment, failed: true };
    }

    const userRef = db.collection('users').doc(payment.uid);

    if (payment.itemType === 'decoration') {
      trx.set(userRef, {
        unlockedDecorations: admin.firestore.FieldValue.arrayUnion(payment.itemId),
        lastRedeemedDecoration: payment.itemId,
      }, { merge: true });
    } else if (payment.itemType === 'badge') {
      const userSnap = await trx.get(userRef);
      const currentUntilMs = userSnap.exists && userSnap.data().verifiedUntil
        ? userSnap.data().verifiedUntil.toMillis()
        : 0;
      const baseMs = Math.max(Date.now(), currentUntilMs);
      const newUntil = admin.firestore.Timestamp.fromMillis(baseMs + BADGE_RENEWAL_DAYS * 24 * 60 * 60 * 1000);
      trx.set(userRef, { verifiedUntil: newUntil }, { merge: true });
    }

    trx.set(paymentRef, {
      status: 'success',
      verifiedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });

    return { alreadyCredited: false, payment };
  });
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { reference } = req.body || {};
  const authHeader = req.headers.authorization || '';
  const idToken = authHeader.startsWith('Bearer ')
    ? authHeader.slice(7)
    : null;

  if (!reference) {
    return res.status(400).json({ error: 'reference is required' });
  }
  if (!idToken) {
    return res.status(401).json({ error: 'Missing auth token' });
  }

  let uid;
  try {
    const decoded = await admin.auth().verifyIdToken(idToken);
    uid = decoded.uid;
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired auth token' });
  }

  try {
    const paymentSnap = await db.collection('payments').doc(reference).get();
    if (!paymentSnap.exists) {
      return res.status(404).json({ error: 'Unknown payment reference' });
    }
    if (paymentSnap.data().uid !== uid) {
      return res.status(403).json({ error: 'This payment does not belong to you' });
    }

    const result = await creditPayment(reference);
    if (result.failed) {
      return res.status(200).json({ success: false, status: 'failed' });
    }
    return res.status(200).json({
      success: true,
      itemType: result.payment.itemType,
      itemId: result.payment.itemId,
    });
  } catch (err) {
    console.error('Verify payment failed:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
