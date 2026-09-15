// /api/react-comment.js
// Server-authoritative sticker reactions on a comment — lives on the
// Render backend (fictionclash-backend), NOT the Vercel fictionclash repo,
// to avoid re-hitting Vercel's function-count ceiling (same reason
// like.js and generate-matchup.js live here instead). Requires the same
// FIREBASE_SERVICE_ACCOUNT_KEY env var as the rest of this repo's api/
// files.
//
// One doc per (comment, uid) in the flat `commentReactions` collection,
// id'd deterministically as `${commentId}_${uid}` so toggling is a
// single upsert/delete rather than a query-then-write. Tapping the same
// sticker again removes the reaction; tapping a different sticker swaps
// it — one active reaction per user per comment, same restraint Discord
// itself doesn't have but keeps this simple and matches how the client
// (sendReaction/refreshReactionPills in app.js) already expects it to
// behave.

import admin from 'firebase-admin';

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(
      JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_KEY)
    ),
  });
}

const db = admin.firestore();

// Mirrors APP_STICKERS in app.js/comment.js/clip-comment.js — kept in
// sync manually since this repo can't import from the client bundle or
// the other repo. Free stickers, unlocked purely by an XP milestone.
const APP_STICKERS = [
  { id: 'pow', requiresXp: 100 },
  { id: 'ko', requiresXp: 200 },
  { id: 'level-up', requiresXp: 300 },
  { id: 'skill-issue', requiresXp: 400 },
  { id: 'votes-in', requiresXp: 500 },
  { id: 'shattered', requiresXp: 600 },
  { id: 'clash', requiresXp: 700 },
  { id: 'lit', requiresXp: 800 },
  { id: 'hero', requiresXp: 900 },
  { id: 'underrated', requiresXp: 1000 },
  { id: 'vs', requiresXp: 1100 },
];

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { parentType, parentId, commentId, stickerId } = req.body || {};
  const authHeader = req.headers.authorization || '';
  const idToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;

  if (!['matchup', 'clip'].includes(parentType) || !parentId || !commentId) {
    return res.status(400).json({ error: 'parentType, parentId, and commentId are required' });
  }
  const stickerDef = APP_STICKERS.find(s => s.id === stickerId);
  if (!stickerDef) {
    return res.status(400).json({ error: 'Unknown sticker' });
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
    // Confirm the comment actually exists in the right place before
    // letting a reaction attach to it — cheap guard against a stale or
    // spoofed commentId/parentId pairing.
    const commentRef = parentType === 'matchup'
      ? db.collection('matchupComments').doc(commentId)
      : db.collection('movieClips').doc(parentId).collection('comments').doc(commentId);
    const commentSnap = await commentRef.get();
    if (!commentSnap.exists) {
      return res.status(404).json({ error: 'Comment not found' });
    }
    if (parentType === 'matchup' && commentSnap.data().matchupId !== parentId) {
      return res.status(404).json({ error: 'Comment not found' });
    }

    // Enforce the XP unlock server-side — the client picker only ever
    // shows unlocked stickers, but this is the actual enforcement point.
    const userSnap = await db.collection('users').doc(uid).get();
    const xp = userSnap.exists ? (userSnap.data().xp || 0) : 0;
    if (xp < stickerDef.requiresXp) {
      return res.status(403).json({ error: `Sticker locked — reach ${stickerDef.requiresXp} XP to unlock it` });
    }

    const reactionRef = db.collection('commentReactions').doc(`${commentId}_${uid}`);
    const existing = await reactionRef.get();

    if (existing.exists && existing.data().stickerId === stickerDef.id) {
      // Same sticker tapped again — remove the reaction (un-react).
      await reactionRef.delete();
      return res.status(200).json({ success: true, reacted: false });
    }

    // New reaction, or switching from a different sticker — one active
    // reaction per user per comment, so this always overwrites rather
    // than adding a second doc.
    await reactionRef.set({
      commentId,
      parentId,
      parentType,
      uid,
      stickerId: stickerDef.id,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    return res.status(200).json({ success: true, reacted: true, stickerId: stickerDef.id });
  } catch (err) {
    console.error('Reaction toggle failed:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
