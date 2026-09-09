// /api/like.js
// Server-authoritative like/unlike toggle for matchups and clips.
// Requires the same FIREBASE_SERVICE_ACCOUNT_KEY env var as vote.js/comment.js.

import admin from 'firebase-admin';

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

  try {
    const liked = await db.runTransaction(async (tx) => {
      const likeSnap = await tx.get(likeRef);

      const uids = (likeSnap.exists && likeSnap.data().uids) || {};
      const currentlyLiked = !!uids[uid];
      const nextLiked = !currentlyLiked;

      tx.set(likeRef, {
        uids: { [uid]: nextLiked ? true : admin.firestore.FieldValue.delete() },
      }, { merge: true });

      return nextLiked;
    });

    // Likes no longer award XP — see vote.js for the only XP source now.
    return res.status(200).json({
      success: true,
      liked,
      xpAwarded: 0,
      rank: null,
    });
  } catch (err) {
    console.error('Like toggle failed:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
