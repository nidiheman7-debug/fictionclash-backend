// api/generate-matchup.js — Render Cron Job entry point.
//
// This is NOT an HTTP route. Render's Cron Jobs are a separate service
// type from your web service — they run a command on a schedule inside
// their own one-off container and exit, they're not reached over the
// network, so there's no CRON_SECRET or Authorization header to check
// here (unlike the Vercel-cron design this replaces). Set this file up
// as a Render Cron Job with:
//   Build Command: npm install
//   Command:       node api/generate-matchup.js
//   Schedule:      whatever cron string you want, e.g. "0 14 * * *" for
//                  once a day at 14:00 UTC
//
// Generates and PUBLISHES a brand-new matchup straight into the live
// `matchups` collection — same shape a fan submission ends up in once
// approved through the pendingMatchups -> moderate.js flow (a/b objects
// with name/version/sub/initials, votesA/votesB starting at 0,
// createdAt), just skipping the review step entirely.
//
// Uses firebase-admin the same way xp.js does (classic `admin` import,
// not the modular firebase-admin/app style) so this matches the rest of
// the backend's conventions — and because it writes via the Admin SDK,
// it bypasses firestore.rules entirely; no rules changes needed.
//
// Env vars needed on the Render Cron Job service:
//   FIREBASE_SERVICE_ACCOUNT_KEY — same one server.js's routes use
//   GEMINI_API_KEY               — same Gemini key character-analysis.js uses

import admin from 'firebase-admin';

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_KEY)),
  });
}
const db = admin.firestore();

const GEMINI_MODEL = 'gemini-3.5-flash-lite'; // matches character-analysis.js
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${process.env.GEMINI_API_KEY}`;

// Layer 1 of the safety check: ask Gemini itself to block anything in
// these categories at a low threshold, rather than relying only on our
// own filtering after the fact.
const GEMINI_SAFETY_SETTINGS = [
  'HARM_CATEGORY_HARASSMENT',
  'HARM_CATEGORY_HATE_SPEECH',
  'HARM_CATEGORY_SEXUALLY_EXPLICIT',
  'HARM_CATEGORY_DANGEROUS_CONTENT',
].map((category) => ({ category, threshold: 'BLOCK_LOW_AND_ABOVE' }));

// Layer 3 backstop: a small local denylist in case something slips past
// Gemini's own safety settings and isn't obviously malformed. Deliberately
// short and generic (slurs/hate terms + a few flags for real-world figures
// sneaking in as "characters") rather than an exhaustive profanity list —
// the point is to catch a bad response, not to police creative writing.
const DENYLIST = [
  'nigger', 'nigga', 'faggot', 'retard', 'kike', 'chink', 'spic', 'tranny',
  'hitler', 'nazi', 'isis', 'al-qaeda', 'bin laden',
  'rape', 'suicide', 'nude', 'porn', 'sex tape',
];

function hitsDenylist(text) {
  const lower = text.toLowerCase();
  return DENYLIST.some((term) => lower.includes(term));
}

// Layer 2: sanity-check the shape of what came back, independent of
// whether the content is offensive — catches URLs, HTML, emails, or
// garbage Gemini occasionally returns instead of a clean character name.
function isCleanField(value, { maxLen = 60 } = {}) {
  if (typeof value !== 'string') return false;
  if (!value.trim() || value.length > maxLen) return false;
  if (/https?:\/\/|www\.|<[a-z]|@[\w.-]+\.\w+/i.test(value)) return false;
  // Letters/numbers/spaces and a modest set of name punctuation only.
  if (!/^[\p{L}\p{N} '".,\-!?&()·]+$/u.test(value)) return false;
  return true;
}

function initialsFor(name) {
  return name.split(' ').map((w) => w[0]).filter(Boolean).slice(0, 2).join('').toUpperCase();
}

// Same "name|version, either order" dedupe key as matchupPairKey() in
// app.js, reimplemented here since this runs server-side and can't
// import client code.
function pairKey(a, b) {
  const keyA = `${a.name.toLowerCase()}|${(a.version || '').toLowerCase()}`;
  const keyB = `${b.name.toLowerCase()}|${(b.version || '').toLowerCase()}`;
  return [keyA, keyB].sort().join('~');
}

async function run() {
  // Pull recent matchups so Gemini has real characters to riff on (the
  // "reuse an existing character, give them a new opponent" half of the
  // mix) and so both Gemini's prompt and our own backstop check can
  // avoid recreating a pairing that's already live.
  const existingSnap = await db.collection('matchups').orderBy('createdAt', 'desc').limit(150).get();
  const existingPairs = new Set();
  const knownCharacters = new Set();
  existingSnap.forEach((doc) => {
    const m = doc.data();
    if (!m.a || !m.b) return;
    existingPairs.add(pairKey(m.a, m.b));
    knownCharacters.add(m.a.name);
    knownCharacters.add(m.b.name);
  });
  const knownList = [...knownCharacters].slice(0, 60);

  const prompt = `You generate character matchup ideas for a "who would win" fan app covering anime, movies, games, and comics.
Return ONLY a JSON object, nothing else, in this exact shape:
{"a":{"name":"Character A","version":"optional form/version, or empty string","source":"franchise or show name"},"b":{"name":"Character B","version":"","source":"franchise or show name"}}

Rules:
- Pick two characters who'd make a genuinely interesting, debatable matchup — comparable power tier, or an intentionally spicy mismatch worth arguing about.
- Roughly half the time, reuse a character from this list already on the app and give them a NEW opponent not already matched against them: ${knownList.join(', ') || '(none yet)'}
- The other half, invent a completely fresh pairing of characters not on that list.
- Never recreate any of these existing pairings: ${[...existingPairs].slice(0, 100).join(' | ') || '(none yet)'}
- Only fictional characters — no real people.
- The two characters must be different (not the same character in two versions).`;

  const geminiRes = await fetch(GEMINI_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { temperature: 1, responseMimeType: 'application/json' },
      safetySettings: GEMINI_SAFETY_SETTINGS,
    }),
  });
  if (!geminiRes.ok) throw new Error(`Gemini request failed: ${geminiRes.status}`);
  const geminiData = await geminiRes.json();
  // Gemini's safety settings above return a response with no candidates
  // (or a candidate with finishReason: "SAFETY") instead of an error
  // status when it blocks its own output — treat that the same as any
  // other failed run: skip publishing, don't throw a confusing parse error.
  const candidate = geminiData?.candidates?.[0];
  if (!candidate || candidate.finishReason === 'SAFETY') {
    throw new Error('Gemini blocked its own response on safety grounds — skipping this run');
  }
  const rawText = candidate?.content?.parts?.[0]?.text;
  if (!rawText) throw new Error('Empty Gemini response');
  const idea = JSON.parse(rawText);
  if (!idea?.a?.name || !idea?.b?.name) throw new Error('Malformed matchup idea from Gemini');

  // Layer 2 — format/sanity check every field before it's trusted.
  for (const [label, value] of [
    ['a.name', idea.a.name], ['a.version', idea.a.version || ''], ['a.source', idea.a.source || ''],
    ['b.name', idea.b.name], ['b.version', idea.b.version || ''], ['b.source', idea.b.source || ''],
  ]) {
    if (!isCleanField(value, { maxLen: label.endsWith('name') ? 60 : 40 })) {
      throw new Error(`Gemini response failed the format check on ${label}: ${JSON.stringify(value)}`);
    }
  }
  // Layer 3 — denylist backstop across every field together.
  const combinedText = [idea.a.name, idea.a.version, idea.a.source, idea.b.name, idea.b.version, idea.b.source]
    .filter(Boolean).join(' ');
  if (hitsDenylist(combinedText)) {
    throw new Error('Gemini response failed the denylist check — skipping this run');
  }

  const a = {
    name: idea.a.name.trim(),
    version: (idea.a.version || '').trim(),
    sub: [idea.a.version, idea.a.source].filter(Boolean).join(' · ') || 'Bot Pick',
    initials: initialsFor(idea.a.name.trim()),
  };
  const b = {
    name: idea.b.name.trim(),
    version: (idea.b.version || '').trim(),
    sub: [idea.b.version, idea.b.source].filter(Boolean).join(' · ') || 'Bot Pick',
    initials: initialsFor(idea.b.name.trim()),
  };

  if (a.name.toLowerCase() === b.name.toLowerCase() && a.version.toLowerCase() === b.version.toLowerCase()) {
    throw new Error('Gemini picked the same character twice');
  }
  if (existingPairs.has(pairKey(a, b))) {
    throw new Error(`Duplicate of an existing matchup (${a.name} vs ${b.name}) — skipping this run`);
  }

  const docRef = await db.collection('matchups').add({
    a, b,
    votesA: 0, votesB: 0,
    botGenerated: true, // shown as "· Bot Pick" in the trend card, see app.js
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  console.log(`Published: ${a.name} vs ${b.name} (${docRef.id})`);
}

run()
  .then(() => process.exit(0))
  .catch((err) => {
    // A failed run (safety block, duplicate, malformed response) just
    // means no matchup gets published today — logged here for Render's
    // Cron Job run history, exits non-zero so a failed run is visible
    // there instead of looking identical to a successful one.
    console.error('generate-matchup failed:', err.message || err);
    process.exit(1);
  });
