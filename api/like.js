// /api/like.js
// Server-authoritative like/unlike toggle for matchups and clips.
// Requires the same FIREBASE_SERVICE_ACCOUNT_KEY env var as vote.js/comment.js.

import admin from 'firebase-admin';
import { awardXp } from './lib/xp.js';

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(
      JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_KEY)
    ),
  });
}

const db = admin.firestore();

const LIKE_XP = 5;

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { targetType, targetId } = req.body || {};
  const authHeader = req.headers.authorization || '';
  const idToken = authHeader.startsWith('Bearer ')
    ? authHeader.slice(7)
    : null;

  if ((targetType !== 'matchup' && targetType !== 'clip') || !targetId) {
    return res.status(400).json({ error: 'targetType ("matchup" or "clip") and targetId are required' });
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

  const key = `${targetType}:${targetId}`;
  const likeRef = db.collection('likes').doc(key);
  // Existence alone gates XP — same one-time-credit pattern as actionCredits
  // elsewhere, so liking/unliking/re-liking the same target can only ever
  // pay out once, no matter how many times it's toggled.
  const creditRef = db.collection('users').doc(uid).collection('actionCredits').doc(`like:${key}`);

  try {
    const { liked, awardXpNeeded } = await db.runTransaction(async (tx) => {
      const [likeSnap, creditSnap] = await Promise.all([
        tx.get(likeRef),
        tx.get(creditRef),
      ]);

      const uids = (likeSnap.exists && likeSnap.data().uids) || {};
      const currentlyLiked = !!uids[uid];
      const nextLiked = !currentlyLiked;

      tx.set(likeRef, {
        uids: { [uid]: nextLiked ? true : admin.firestore.FieldValue.delete() },
      }, { merge: true });

      let awardXpNeeded = false;
      if (nextLiked && !creditSnap.exists) {
        tx.set(creditRef, {
          type: 'like',
          points: LIKE_XP,
          creditedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
        awardXpNeeded = true;
      }

      return { liked: nextLiked, awardXpNeeded };
    });

    // Awaited (not fire-and-forget) so Vercel can't freeze this function
    // before the XP write lands — same fix as vote.js/comment.js. A hiccup
    // here shouldn't fail the like itself, so it's swallowed.
    let xpResult = null;
    if (awardXpNeeded) {
      try {
        xpResult = await awardXp(db, uid, LIKE_XP);
      } catch (err) {
        console.error('XP award failed:', err);
      }
    }

    return res.status(200).json({
      success: true,
      liked,
      xpAwarded: xpResult ? LIKE_XP : 0,
      rank: xpResult ? xpResult.rank : null,
    });
  } catch (err) {
    console.error('Like toggle failed:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
