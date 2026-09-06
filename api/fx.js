// /api/lib/fx.js
// Gets the current USD -> NGN rate, cached in Firestore at config/fxRate
// and refreshed at most once every FX_TTL_MS. This keeps checkout fast
// and avoids burning calls against the free FX API on every single
// purchase — the naira price only needs to track the real rate loosely,
// not to the second.
//
// Uses open.er-api.com — free, no API key. If it's ever swapped for a
// paid provider, only this file needs to change.

const FX_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours
// Used only if Firestore has no cached rate at all AND the live fetch
// also fails (e.g. first-ever call happens during an outage). Not meant
// to stay accurate — it's a last-resort fallback, not a price.
const FALLBACK_RATE = 1385;

export async function getUsdToNgnRate(db) {
  const rateRef = db.collection('config').doc('fxRate');
  const snap = await rateRef.get();
  const cached = snap.exists ? snap.data() : null;
  const cachedAgeMs = cached?.fetchedAt ? Date.now() - cached.fetchedAt.toMillis() : Infinity;

  if (cached?.rate && cachedAgeMs < FX_TTL_MS) {
    return cached.rate;
  }

  try {
    const resp = await fetch('https://open.er-api.com/v6/latest/USD');
    if (!resp.ok) throw new Error(`FX fetch failed: ${resp.status}`);
    const data = await resp.json();
    const rate = data?.rates?.NGN;
    if (!rate || typeof rate !== 'number') throw new Error('NGN rate missing from FX response');

    await rateRef.set({
      rate,
      fetchedAt: new Date(),
      source: 'open.er-api.com',
    });
    return rate;
  } catch (err) {
    console.error('FX rate fetch failed, falling back:', err);
    // Stale cached rate beats no rate — prefer it over the hardcoded
    // fallback if one exists at all, even past its TTL.
    if (cached?.rate) return cached.rate;
    return FALLBACK_RATE;
  }
}
