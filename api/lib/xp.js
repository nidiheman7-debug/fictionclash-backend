// /api/lib/xp.js
// Shared helper for awarding XP server-side. Any endpoint that awards XP
// (vote.js, comment.js, like.js, clip-comment.js, share.js) should go
// through this instead of writing `xp` directly, so the verified-badge
// threshold logic and weekly-leaderboard bookkeeping live in exactly one
// place.

import admin from 'firebase-admin';

export const VERIFIED_BADGE_POINTS = 1000;
export const VERIFIED_BADGE_DAYS = 30;

// Awards `delta` XP to users/{uid}, to the lifetime `xp` total, to
// `weeklyXp` (zeroed out every Monday by /api/reset-weekly-xp — see that
// file for the schedule), AND — only while a season is live — to
// `seasonShards`, the standalone currency used to buy Season-exclusive
// avatar decorations (see SEASONS in index.html).
//
// seasonShards is stored as a MAP keyed by season id, e.g.
// { anime: 40, horror: 15 } — NOT a single flat number. Earlier versions
// of this function used one flat number shared across every season
// forever, which is why a brand-new season used to open already showing
// leftover points from whatever came before. Keying by season id means a
// new season's bucket is simply absent until someone earns into it, so
// its leaderboard/balance naturally starts at 0.
//
// If a doc still has the old flat-number shape (or no shards at all),
// it's treated as an empty map rather than migrated — that old number
// was never trustworthy season data to begin with (see above), so
// there's nothing worth preserving from it.
//
// seasonShards is deliberately separate from xp/weeklyXp: it earns from
// the same actions at the same rate, but nothing that spends it ever
// touches the xp total, and nothing that spends xp would touch shards
// either. If this pushes the lifetime xp total across a new multiple of
// 1000, grants (or re-grants) a fresh 1-month verified badge. Runs in
// its own transaction so the pre-award values are read consistently
// even under concurrent requests.
export async function awardXp(db, uid, delta) {
  const userRef = db.collection('users').doc(uid);
  const seasonRef = db.collection('appConfig').doc('activeSeason');
  const result = await db.runTransaction(async (tx) => {
    const [snap, seasonSnap] = await Promise.all([tx.get(userRef), tx.get(seasonRef)]);
    const currentXp = (snap.exists && snap.data().xp) || 0;
    const currentWeeklyXp = (snap.exists && snap.data().weeklyXp) || 0;
    const newXp = currentXp + delta;
    const newWeeklyXp = currentWeeklyXp + delta;
    const updates = { xp: newXp, weeklyXp: newWeeklyXp };

    const activeSeasonId = seasonSnap.exists ? seasonSnap.data().seasonId : null;
    let newShardsForSeason = null;
    if (activeSeasonId) {
      const rawShards = snap.exists && snap.data().seasonShards;
      // Only trust it as a per-season map; a legacy flat number (or
      // nothing at all) starts fresh at {} — see comment above.
      const shardsMap = (rawShards && typeof rawShards === 'object' && !Array.isArray(rawShards))
        ? rawShards
        : {};
      newShardsForSeason = (shardsMap[activeSeasonId] || 0) + delta;
      updates.seasonShards = { ...shardsMap, [activeSeasonId]: newShardsForSeason };
    }

    const crossedBadgeThreshold =
      Math.floor(newXp / VERIFIED_BADGE_POINTS) > Math.floor(currentXp / VERIFIED_BADGE_POINTS);

    let verifiedUntil = null;
    if (crossedBadgeThreshold) {
      verifiedUntil = admin.firestore.Timestamp.fromMillis(
        Date.now() + VERIFIED_BADGE_DAYS * 24 * 60 * 60 * 1000
      );
      updates.verifiedUntil = verifiedUntil;
    }

    tx.set(userRef, updates, { merge: true });
    // newShards is scoped to whichever season is active right now (or
    // null if none is) — callers that echo this back to the client
    // (vote.js etc.) are already treating it that way.
    return { newXp, newWeeklyXp, newShards: newShardsForSeason, badgeGranted: crossedBadgeThreshold, verifiedUntil };
  });

  // All-time rank: 1 + however many users have strictly more lifetime XP.
  // Best-effort — a failure here shouldn't undo or fail the XP award
  // itself, so a null rank just means the caller's "You're now #N" toast
  // skips that line rather than showing something wrong.
  let rank = null;
  try {
    const aggSnap = await db.collection('users').where('xp', '>', result.newXp).count().get();
    rank = aggSnap.data().count + 1;
  } catch (err) {
    console.error('Rank computation failed:', err);
  }

  return { ...result, rank };
}
