// Service worker: talks to Scryfall, rate-limits requests, caches results.
//
// Scryfall rate limits (https://scryfall.com/docs/api/rate-limits):
//   /cards/search and /cards/named: 2 requests/second.
//   A 429 locks you out for 30 seconds; ignoring 429s can get you banned.

const API = 'https://api.scryfall.com';
const CACHE_VERSION = 'v2:'; // bump when the cached shape changes
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // Scryfall updates prices ~once a day
const MIN_GAP_MS = 550; // a bit over the 500ms Scryfall requires for /cards/*
const LOCKOUT_MS = 31000; // Scryfall's 429 lockout is 30 seconds
const FETCH_TIMEOUT_MS = 10000;
const MAX_ATTEMPTS = 2;

// ---------- throttled fetch (one request at a time, spaced out) ----------

let nextAllowed = 0; // timestamp before which no request may be sent
let queue = Promise.resolve();

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function scryfallFetch(url) {
  const run = async () => {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const wait = nextAllowed - Date.now();
      if (wait > 0) await sleep(wait);
      nextAllowed = Date.now() + MIN_GAP_MS;

      let res;
      try {
        // Without a timeout, one hung request would block the whole queue.
        res = await fetch(url, {
          headers: { Accept: 'application/json' },
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        });
      } catch (e) {
        console.warn('[scrylair] fetch failed', url, e);
        if (attempt < MAX_ATTEMPTS) continue;
        throw new Error(e.name === 'TimeoutError' ? 'Scryfall timed out' : 'Network error');
      }

      if (res.status === 429) {
        // Back off for the whole lockout before any further request (from any tab).
        console.warn('[scrylair] 429 from Scryfall, pausing all requests for 30s');
        nextAllowed = Date.now() + LOCKOUT_MS;
        continue;
      }
      return res;
    }
    throw new Error('Rate limited by Scryfall, try again in a minute');
  };
  const p = queue.then(run);
  queue = p.catch(() => {});
  return p;
}

// ---------- Scryfall lookups ----------

const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

function slimPrinting(c) {
  const p = c.prices || {};
  const flavors = [c.flavor_name, ...(c.card_faces || []).map((f) => f.flavor_name)].filter(Boolean);
  return {
    uri: c.scryfall_uri,
    setName: c.set_name,
    num: c.collector_number,
    released: c.released_at,
    sl: /^secret lair/i.test(c.set_name),
    flavors, // "as “…”" names, used to find this drop's SL printing
    ub: (c.promo_types || []).includes('universesbeyond') || c.security_stamp === 'triangle',
    usd: p.usd,
    usd_foil: p.usd_foil,
    usd_etched: p.usd_etched,
    eur: p.eur,
    eur_foil: p.eur_foil,
    eur_etched: p.eur_etched,
  };
}

// All paper printings matching a search query, or null if nothing matches.
async function searchPrintings(q) {
  let url = `${API}/cards/search?q=${encodeURIComponent(q + ' game:paper')}&unique=prints&order=released`;
  let first = null;
  const printings = [];
  while (url) {
    const res = await scryfallFetch(url);
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`Scryfall error ${res.status}`);
    const page = await res.json();
    first ??= page.data[0];
    for (const c of page.data) printings.push(slimPrinting(c));
    url = page.has_more ? page.next_page : null;
  }
  return { name: first.name, uri: first.scryfall_uri, printings };
}

// 1. Exact-name search (also matches a face name, e.g. "Fire" -> "Fire // Ice"):
//    one request for the common case.
// 2. Otherwise a fuzzy lookup, accepted only when it's the same name modulo
//    punctuation/case, so a card Scryfall doesn't know yet doesn't silently
//    resolve to a similarly named, different card ("Planar Gateway" -> "Planar Gate").
async function findCard(name) {
  const clean = name.replace(/[‘’]/g, "'").replace(/"/g, '');
  const exact = await searchPrintings(`!"${clean}"`);
  if (exact) return exact;

  const res = await scryfallFetch(`${API}/cards/named?fuzzy=${encodeURIComponent(clean)}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Scryfall error ${res.status}`);
  const fuzzy = await res.json();
  const names = [fuzzy.name, ...(fuzzy.card_faces || []).map((f) => f.name)];
  if (!names.some((n) => norm(n) === norm(clean))) return null;
  return searchPrintings(`oracleid:${fuzzy.oracle_id}`);
}

// ---------- cache ----------

async function cacheGet(key) {
  const obj = await chrome.storage.local.get(key);
  const entry = obj[key];
  if (entry && Date.now() - entry.t < CACHE_TTL_MS) return entry.v;
  return undefined;
}

// Caching is best-effort: a failed write (e.g. quota) must not break the lookup.
async function cacheSet(key, v) {
  try {
    await chrome.storage.local.set({ [key]: { t: Date.now(), v } });
  } catch (e) {
    console.warn('[scrylair] cache write failed, clearing cache', e);
    await chrome.storage.local.clear().catch(() => {});
  }
}

// ---------- main lookup ----------

const inFlight = new Map();

async function lookupOne(name) {
  const key = CACHE_VERSION + name.toLowerCase();
  const cached = await cacheGet(key);
  if (cached !== undefined) return cached;

  const result = await findCard(name); // errors propagate and are not cached
  await cacheSet(key, result);
  return result;
}

// Try each candidate name in order; first hit wins.
async function lookup(candidates) {
  for (const name of candidates) {
    if (!name) continue;
    const k = name.toLowerCase();
    if (!inFlight.has(k)) {
      inFlight.set(k, lookupOne(name).finally(() => inFlight.delete(k)));
    }
    const result = await inFlight.get(k);
    if (result) return result;
  }
  return null;
}

// Drop stale cache entries (possibly in an older format) on install/update.
chrome.runtime.onInstalled.addListener(() => chrome.storage.local.clear());

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'lookup') {
    lookup(msg.candidates)
      .then((card) => sendResponse({ card }))
      .catch((e) => {
        console.error('[scrylair] lookup failed', msg.candidates, e);
        sendResponse({ error: String(e.message || e) });
      });
    return true; // async response
  }
  if (msg?.type === 'clearCache') {
    chrome.storage.local.clear().then(() => sendResponse({ ok: true }));
    return true;
  }
});
