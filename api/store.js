import { sql } from "@vercel/postgres";

// Shared key/value store for the whole app state (one JSON document per key).
//
// Redundant, non-destructive storage:
//   * TWO databases hold the data — Supabase (wellness_store) and the original
//     Vercel Postgres / Neon (kv_store).
//   * Reads return whichever copy is newest, and best-effort "heal" the stale
//     side so both converge.
//   * Writes go to both; the request succeeds if EITHER accepts it, so a
//     paused/quota-blocked database never blocks the clinic.
//   * Nothing is ever deleted.
//
// Bandwidth: GET supports `&meta=1`, which returns only the document's
// timestamp and size (a few dozen bytes) instead of the whole document. The
// client polls that and downloads the full document only when it has actually
// changed — without this, 5-second polling of a ~200KB document burns several
// GB of transfer per day and trips hosting quotas.

const SB_URL = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const sbOn = !!(SB_URL && SB_KEY);
const SB_TABLE = "wellness_store";

const sbHeaders = () => ({ apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, "Content-Type": "application/json" });
const ts = (x) => { const t = new Date(x || 0).getTime(); return Number.isFinite(t) ? t : 0; };
const iso = (ms) => new Date(ms || 0).toISOString();
// Members held in a stored document — used to refuse writes that would replace
// real data with an empty copy.
const memberCount = (raw) => { try { const s = JSON.parse(raw); return Array.isArray(s.members) ? s.members.length : 0; } catch { return 0; } };

// Circuit breaker: when a database is failing (quota, suspended, unreachable),
// stop hammering it for a while instead of paying its latency on every request.
const BREAKER_MS = 10 * 60 * 1000;
let sbBlockedUntil = 0;
let neonBlockedUntil = 0;
const now = () => Date.now();

async function sbGet(key, metaOnly) {
  const cols = metaOnly ? "updated_at" : "value,updated_at";
  const r = await fetch(`${SB_URL}/rest/v1/${SB_TABLE}?key=eq.${encodeURIComponent(key)}&select=${cols}`, { headers: sbHeaders() });
  if (!r.ok) throw new Error("supabase get " + r.status);
  const rows = await r.json();
  if (!rows[0]) return null;
  return { value: metaOnly ? undefined : rows[0].value, at: ts(rows[0].updated_at) };
}
async function sbSet(key, value, at) {
  const r = await fetch(`${SB_URL}/rest/v1/${SB_TABLE}`, {
    method: "POST",
    headers: { ...sbHeaders(), Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify({ key, value, updated_at: iso(at || now()) }),
  });
  if (!r.ok) throw new Error("supabase set " + r.status + " " + (await r.text()).slice(0, 200));
}

let neonReady = false;
async function neonEnsure() {
  if (neonReady) return;
  await sql`CREATE TABLE IF NOT EXISTS kv_store (key text PRIMARY KEY, value text NOT NULL, updated_at timestamptz NOT NULL DEFAULT now())`;
  neonReady = true;
}
async function neonGet(key, metaOnly) {
  await neonEnsure();
  const { rows } = metaOnly
    ? await sql`SELECT updated_at FROM kv_store WHERE key = ${key}`
    : await sql`SELECT value, updated_at FROM kv_store WHERE key = ${key}`;
  if (!rows[0]) return null;
  return { value: metaOnly ? undefined : rows[0].value, at: ts(rows[0].updated_at) };
}
async function neonSet(key, value, at) {
  await neonEnsure();
  await sql`INSERT INTO kv_store (key, value, updated_at) VALUES (${key}, ${value}, ${iso(at || now())})
            ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`;
}

// Run a backend call, tracking its circuit breaker.
async function tryBackend(which, fn) {
  const blockedUntil = which === "sb" ? sbBlockedUntil : neonBlockedUntil;
  if (now() < blockedUntil) return { ok: false, skipped: true, e: new Error("temporarily skipped after recent failure") };
  try {
    const v = await fn();
    if (which === "sb") sbBlockedUntil = 0; else neonBlockedUntil = 0;
    return { ok: true, v };
  } catch (e) {
    if (which === "sb") sbBlockedUntil = now() + BREAKER_MS; else neonBlockedUntil = now() + BREAKER_MS;
    return { ok: false, e };
  }
}

export default async function handler(req, res) {
  const required = process.env.APP_ACCESS_KEY;
  if (required && req.headers["x-app-key"] !== required) {
    return res.status(401).json({ error: "unauthorized" });
  }
  res.setHeader("Cache-Control", "no-store");

  try {
    if (req.method === "GET") {
      const key = req.query.key;
      if (!key) return res.status(400).json({ error: "missing key" });
      const metaOnly = req.query.meta === "1";

      // Read one specific database, bypassing the newest-wins comparison. Used
      // by the restore page to pull a named copy (e.g. the original database
      // once its quota clears) without waiting for it to look "newest".
      const source = req.query.source;
      if (source === "neon" || source === "supabase") {
        const r = source === "neon"
          ? await tryBackend("neon", () => neonGet(key, false))
          : (sbOn ? await tryBackend("sb", () => sbGet(key, false)) : { ok: false, e: new Error("supabase not configured") });
        if (!r.ok) return res.status(502).json({ error: `${source} unavailable: ` + String((r.e && r.e.message) || r.e).slice(0, 300) });
        if (!r.v) return res.status(200).json({ key, value: null, updatedAt: null, source });
        return res.status(200).json({ key, value: r.v.value, updatedAt: iso(r.v.at), source });
      }

      const [s, n] = await Promise.all([
        sbOn ? tryBackend("sb", () => sbGet(key, metaOnly)) : { ok: false, skipped: true },
        tryBackend("neon", () => neonGet(key, metaOnly)),
      ]);
      const sv = s.ok ? s.v : null;
      const nv = n.ok ? n.v : null;
      let winner = sv && nv ? (sv.at >= nv.at ? sv : nv) : (sv || nv);
      // If the newest copy is empty but the other one holds real data, trust the
      // data over the clock. Otherwise a blank database, simply by being newer,
      // would keep hiding a good copy in the other database forever.
      if (!metaOnly && sv && nv) {
        const newer = sv.at >= nv.at ? sv : nv;
        const older = sv.at >= nv.at ? nv : sv;
        const newerN = memberCount(newer.value);
        const olderN = memberCount(older.value);
        if (olderN > 0 && (newerN === 0 || newerN < olderN / 2)) winner = older;
      }

      if (!winner) return res.status(200).json({ key, value: null, updatedAt: null });

      if (metaOnly) return res.status(200).json({ key, updatedAt: iso(winner.at), exists: true });

      // Heal whichever side is missing or stale (best-effort, never blocking) —
      // but NEVER overwrite a copy that holds real data with a drastically
      // emptier one, even if the emptier one is newer. Without this, a blank
      // database would erase the good copy in the other database.
      const wN = memberCount(winner.value);
      const safeToOverwrite = (existing) => { if (!existing) return true; const eN = memberCount(existing.value); return !(eN > 0 && (wN === 0 || wN < eN / 2)); };
      if (sbOn && s.ok && (!sv || sv.at < winner.at) && safeToOverwrite(sv)) sbSet(key, winner.value, winner.at).catch(() => {});
      if (n.ok && (!nv || nv.at < winner.at) && safeToOverwrite(nv)) neonSet(key, winner.value, winner.at).catch(() => {});

      return res.status(200).json({ key, value: winner.value, updatedAt: iso(winner.at) });
    }

    if (req.method === "POST") {
      const { key, value } = req.body || {};
      if (!key || typeof value !== "string") return res.status(400).json({ error: "bad request" });
      const at = now();
      const writes = await Promise.all([
        sbOn ? tryBackend("sb", () => sbSet(key, value, at)) : { ok: false, skipped: true },
        tryBackend("neon", () => neonSet(key, value, at)),
      ]);
      if (writes.some((w) => w.ok)) {
        // Rolling snapshots so any bad state is always recoverable: one slot per
        // hour of the day and one per day of the week, overwritten as they come
        // around again. That is a bounded 31 extra rows, no migration needed,
        // and it means the last ~24 hours and ~7 days are always retrievable.
        // Only snapshot copies that actually contain members.
        if (sbOn && memberCount(value) > 0) {
          const d = new Date(at);
          sbSet(`${key}#snap-h${d.getUTCHours()}`, value, at).catch(() => {});
          sbSet(`${key}#snap-d${d.getUTCDay()}`, value, at).catch(() => {});
        }
        return res.status(200).json({ key, value, updatedAt: iso(at) });
      }
      const err = writes.filter((w) => w.e).map((w) => String((w.e && w.e.message) || w.e)).join(" | ");
      return res.status(500).json({ error: "save failed: " + err });
    }

    if (req.method === "DELETE") {
      const key = req.query.key;
      if (!key) return res.status(400).json({ error: "missing key" });
      if (sbOn) { try { await fetch(`${SB_URL}/rest/v1/${SB_TABLE}?key=eq.${encodeURIComponent(key)}`, { method: "DELETE", headers: sbHeaders() }); } catch {} }
      try { await neonSet(key, "", now()); } catch {} // tombstone, never hard-delete the backup
      return res.status(200).json({ key, deleted: true });
    }

    res.setHeader("Allow", "GET, POST, DELETE");
    return res.status(405).json({ error: "method not allowed" });
  } catch (e) {
    return res.status(500).json({ error: String((e && e.message) || e) });
  }
}
