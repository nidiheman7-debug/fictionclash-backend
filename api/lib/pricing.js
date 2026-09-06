// /api/lib/pricing.js
// Canonical prices for real-money items. This is the ONLY place the
// backend trusts for how much something costs — create-payment.js looks
// up the amount from here by id, it never trusts a price sent by the
// client. Prices are in USD; the actual naira amount charged is computed
// at checkout time from the live rate (see lib/fx.js), because FX moves
// and a fixed naira price would drift from the $ figure shown in the app.
//
// Keep this in sync with the `premium`/`cash.usd` entries in
// PROFILE_DECORATIONS inside index.html — that copy is for display only,
// this copy is what actually gets charged.

export const PREMIUM_DECORATIONS = {
  'web-trap': 0.43,
  'voltage': 0.51,
  'solar-orbit': 0.65,
  'kryptonian-flight': 0.36,
  'dark-knight': 0.36,
  'thunderstrike': 0.36,
  'real-flame': 0.87,
  'overdrive-aura': 0.65,
  'skeletal-reaper': 0.72,
};

// Profile CARD effects (Theme Store > Card effects) that cost real money.
// Meteor Fall isn't listed here — it's free, gated behind an XP threshold
// instead (see isValidEquipmentChange() in firestore.rules), never a
// Paystack item.
export const PREMIUM_CARD_EFFECTS = {
  'overgrowth': 0.70,
};

// Verified-badge renewal: $3.61 buys 7 days, stacked onto the user's
// current verifiedUntil (or from now, if it's already expired).
export const BADGE_RENEWAL_USD = 3.61;
export const BADGE_RENEWAL_DAYS = 7;
