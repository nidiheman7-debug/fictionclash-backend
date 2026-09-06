// /api/create-payment.js
// Starts a Paystack checkout for a premium (real-money) item: a premium
// avatar decoration, or a verified-badge weekly renewal. The client only
// ever sends WHAT it wants to buy (itemType + itemId) — never an amount.
// The amount is looked up from lib/pricing.js and converted to naira here,
// server-side, using the live rate from lib/fx.js. Requires the same
// FIREBASE_SERVICE_ACCOUNT_KEY env var as vote.js/comment.js/like.js, plus
// PAYSTACK_SECRET_KEY (Paystack's live secret key).

import admin from 'firebase-admin';
import { PREMIUM_DECORATIONS, PREMIUM_CARD_EFFECTS, BADGE_RENEWAL_USD } from './lib/pricing.js';
import { getUsdToNgnRate } from './lib/fx.js';

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(
      JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_KEY)
    ),
  });
}

const db = admin.firestore();

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { itemType, itemId, returnUrl } = req.body || {};
  const authHeader = req.headers.authorization || '';
  const idToken = authHeader.startsWith('Bearer ')
    ? authHeader.slice(7)
    : null;

  if (itemType !== 'decoration' && itemType !== 'cardEffect' && itemType !== 'badge') {
    return res.status(400).json({ error: 'itemType must be "decoration", "cardEffect", or "badge"' });
  }
  if (itemType === 'decoration' && (!itemId || !PREMIUM_DECORATIONS[itemId])) {
    return res.status(400).json({ error: 'Unknown or non-premium itemId' });
  }
  if (itemType === 'cardEffect' && (!itemId || !PREMIUM_CARD_EFFECTS[itemId])) {
    return res.status(400).json({ error: 'Unknown or non-premium itemId' });
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

  const usd = itemType === 'decoration' ? PREMIUM_DECORATIONS[itemId]
    : itemType === 'cardEffect' ? PREMIUM_CARD_EFFECTS[itemId]
    : BADGE_RENEWAL_USD;

  // Guards against double-taps (or any concurrent duplicate request)
  // starting two Paystack sessions for the same item before the first
  // one completes. Keyed by uid+item so it only blocks a *repeat* of
  // this exact purchase, never other purchases. The lock self-expires
  // after LOCK_TTL_MS so an abandoned checkout (tab closed, payment
  // never finished) doesn't permanently block a real retry.
  const LOCK_TTL_MS = 10 * 60 * 1000; // 10 minutes
  const lockRef = db.collection('purchaseLocks').doc(`${uid}_${itemType}_${itemId || 'badge'}`);

  try {
    await db.runTransaction(async (trx) => {
      if (itemType === 'decoration' || itemType === 'cardEffect') {
        const ownedField = itemType === 'decoration' ? 'unlockedDecorations' : 'unlockedCardEffects';
        const userSnap = await trx.get(db.collection('users').doc(uid));
        const owned = userSnap.exists && Array.isArray(userSnap.data()[ownedField])
          ? userSnap.data()[ownedField]
          : [];
        if (owned.includes(itemId)) {
          throw Object.assign(new Error('already-owned'), { code: 'already-owned' });
        }
      }

      const lockSnap = await trx.get(lockRef);
      const lockAgeMs = lockSnap.exists && lockSnap.data().createdAt
        ? Date.now() - lockSnap.data().createdAt.toMillis()
        : Infinity;
      if (lockSnap.exists && lockAgeMs < LOCK_TTL_MS) {
        throw Object.assign(new Error('purchase-in-progress'), { code: 'purchase-in-progress' });
      }

      trx.set(lockRef, { createdAt: admin.firestore.FieldValue.serverTimestamp() });
    });
  } catch (err) {
    if (err.code === 'already-owned') {
      return res.status(409).json({ error: 'You already own this item' });
    }
    if (err.code === 'purchase-in-progress') {
      return res.status(409).json({ error: 'A purchase for this item is already in progress. Please wait a moment and try again.' });
    }
    console.error('Purchase lock failed:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }

  try {
    // Firebase Auth is the source of truth for email, not whatever the
    // client claims — same reasoning as pulling name/avatar server-side
    // in comment.js rather than trusting the request body.
    let email;
    try {
      const authUser = await admin.auth().getUser(uid);
      email = authUser.email;
    } catch (err) {
      // fall through — email stays undefined, handled below
    }
    if (!email) {
      const userSnap = await db.collection('users').doc(uid).get();
      email = userSnap.exists ? userSnap.data().email : null;
    }
    if (!email) {
      await lockRef.delete().catch(() => {});
      return res.status(400).json({ error: 'Add an email to your account before buying premium items' });
    }

    const rate = await getUsdToNgnRate(db);
    const ngn = Math.round(usd * rate);
    const amountKobo = ngn * 100;

    const reference = `fc_${itemType}_${itemId || 'renew'}_${uid.slice(0, 8)}_${Date.now()}`;

    const paystackResp = await fetch('https://api.paystack.co/transaction/initialize', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        email,
        amount: amountKobo,
        currency: 'NGN',
        reference,
        callback_url: returnUrl || undefined,
        metadata: { uid, itemType, itemId: itemId || null },
      }),
    });
    const paystackData = await paystackResp.json();
    if (!paystackResp.ok || !paystackData.status) {
      console.error('Paystack initialize failed:', paystackData);
      await lockRef.delete().catch(() => {});
      return res.status(502).json({ error: 'Could not start checkout' });
    }

    // Recorded BEFORE redirecting the user to Paystack so verify-payment.js
    // and the webhook always have a pending record to check the payment
    // against, however the user's flow ends (success, abandonment, or the
    // app closing mid-payment).
    await db.collection('payments').doc(reference).set({
      uid,
      itemType,
      itemId: itemId || null,
      usd,
      ngn,
      amountKobo,
      rate,
      status: 'pending',
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    return res.status(200).json({
      success: true,
      authorization_url: paystackData.data.authorization_url,
      reference,
    });
  } catch (err) {
    console.error('Create payment failed:', err);
    await lockRef.delete().catch(() => {});
    return res.status(500).json({ error: 'Internal server error' });
  }
}
