// /api/settle-matchup.js
// Resolves a blind-voting matchup (one with revealAt set) once its timer
// has passed: freezes a winning side, marks it settled, and pays
// MATCHUP_WIN_XP to every voter who backed that side. Nothing calls this
// on a schedule — any signed-in viewer's browser fires it the moment it
// notices a matchup is past revealAt but not yet resultsSettled (see
// triggerSettleIfNeeded() in app.js), so it has to be safe to call
// concurrently, repeatedly, and by someone who didn't even vote.
//
// Requires FIREBASE_SERVICE_ACCOUNT_KEY env var on Vercel, same as
// vote.js.

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

const MATCHUP_WIN_XP = 15;

// How many awardXp() calls run at once during the payout sweep. Each one
// is its own Firestore transaction plus a rank-lookup aggregation query
// (see lib/xp.js) — genuinely not cheap when it's not just one voter but
// potentially hundreds, so this is deliberately chunked rather than fired
// with Promise.all across the whole voter list at once.
const PAYOUT_CONCURRENCY = 20;

async function payWinners(uids) {
  let paid = 0;
  for (let i = 0; i < uids.length; i += PAYOUT_CONCURRENCY) {
    const chunk = uids.slice(i, i + PAYOUT_CONCURRENCY);
    const results = await Promise.allSettled(
      chunk.map((uid) => awardXp(db, uid, MATCHUP_WIN_XP))
    );
    results.forEach((r) => {
      if (r.status === 'fulfilled') paid++;
      else console.error('Win-XP payout failed for one voter:', r.reason);
    });
  }
  return paid;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { matchupId } = req.body || {};
  const authHeader = req.headers.authorization || '';
  const idToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;

  if (!matchupId) {
    return res.status(400).json({ error: 'matchupId is required' });
  }
  if (!idToken) {
    return res.status(401).json({ error: 'Missing auth token' });
  }

  // Whoever's browser happens to trigger this doesn't need to be the
  // matchup's owner or an admin — settling isn't a privileged action,
  // it's just "the timer ran out, do the thing." It DOES need to be a
  // real signed-in user though, same bar as voting, so this can't be
  // hammered anonymously.
  try {
    await admin.auth().verifyIdToken(idToken);
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired auth token' });
  }

  const matchupRef = db.collection('matchups').doc(matchupId);

  try {
    // Claim the settle FIRST, atomically, before any XP goes out. This is
    // what makes concurrent triggers from multiple viewers safe — only
    // one of them will win this transaction and proceed to pay winners;
    // everyone else's call lands here, sees resultsSettled already true,
    // and returns immediately. The tradeoff: if the payout loop below
    // times out partway through a very large voter list, those remaining
    // winners are never paid — resultsSettled is already true, so nothing
    // will ever retry them. Acceptable at today's vote counts; would need
    // a real job queue (claim → payout → mark done, resumable) once
    // matchups regularly pull hundreds+ voters.
    const claim = await db.runTransaction(async (tx) => {
      const snap = await tx.get(matchupRef);
      if (!snap.exists) throw { status: 404, message: 'Matchup not found' };
      const matchup = snap.data();

      if (!matchup.revealAt) {
        throw { status: 400, message: 'This matchup has no reveal timer' };
      }
      if (matchup.revealAt.toMillis() > Date.now()) {
        throw { status: 409, message: 'Reveal timer has not run out yet' };
      }
      if (matchup.resultsSettled) {
        // Already handled by an earlier trigger — not an error, just
        // nothing left to do. Return what's already there so the caller
        // can still update its local UI.
        return { alreadySettled: true, winningSide: matchup.winningSide, votesA: matchup.votesA || 0, votesB: matchup.votesB || 0 };
      }

      const votesA = matchup.votesA || 0;
      const votesB = matchup.votesB || 0;
      const winningSide = votesA === votesB ? 'tie' : votesA > votesB ? 'a' : 'b';

      tx.update(matchupRef, { resultsSettled: true, winningSide });
      return { alreadySettled: false, winningSide, votesA, votesB };
    });

    if (claim.alreadySettled || claim.winningSide === 'tie') {
      return res.status(200).json({
        success: true,
        winningSide: claim.winningSide,
        votesA: claim.votesA,
        votesB: claim.votesB,
        xpPaidTo: 0,
      });
    }

    // Outside the transaction on purpose — this is a big fan-out over
    // however many people voted for the winning side, which has no
    // business holding a Firestore transaction open while it runs.
    const votersSnap = await matchupRef
      .collection('voters')
      .where('votedFor', '==', claim.winningSide)
      .get();
    const winnerUids = votersSnap.docs.map((d) => d.id);
    const paidCount = await payWinners(winnerUids);

    return res.status(200).json({
      success: true,
      winningSide: claim.winningSide,
      votesA: claim.votesA,
      votesB: claim.votesB,
      xpPaidTo: paidCount,
    });
  } catch (err) {
    if (err && err.status) {
      return res.status(err.status).json({ error: err.message });
    }
    console.error('Settle-matchup failed:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
