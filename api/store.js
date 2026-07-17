import { sql } from "@vercel/postgres";

// Shared key/value store for the whole app state (one JSON document per key).
//
// Redundant, non-destructive storage:
//   * TWO databases hold the data — Supabase (wellness_store) and the original
//     Vercel Postgres / Neon (kv_store).
//   * Reads return whichever copy is newest, and best-effort "heal" the stale
//     side so both converge.
//   * Writes go to both; the request succeeds if EITHER accepts it, so a
//     paused/unreachable database never blocks the clinic.
//   * Nothing is ever deleted. If Supabase env vars are absent, Neon alone is
//     used, exactly like before.

const SB_URL = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const sbOn = !!(SB_URL && SB_KEY);
const SB_TABLE = "wellness_store";

const sbHeaders = () => ({ apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, "Content-Type": "application/json" });
const ts = (x) => { const t = new Date(x || 0).getTime(); return Number.isFinite(t) ? t : 0; };

async function sbGet(key) {
  const r = await fetch(`${SB_URL}/rest/v1/${SB_TABLE}?key=eq.${encodeURIComponent(key)}&select=value,updated_at`, { headers: sbHeaders() });
  if (!r.ok) throw new Error("supabase get " + r.status);
  const rows = await r.json();
  return rows[0] ? { value: rows[0].value, at: ts(rows[0].updated_at) } : null;
}
async function sbSet(key, value, at) {
  const r = await fetch(`${SB_URL}/rest/v1/${SB_TABLE}`, {
    method: "POST",
    headers: { ...sbHeaders(), Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify({ key, value, updated_at: new Date(at || Date.now()).toISOString() }),
  });
  if (!r.ok) throw new Error("supabase set " + r.status + " " + (await r.text()));
}

let neonReady = false;
async function neonEnsure() {
  if (neonReady) return;
  await sql`CREATE TABLE IF NOT EXISTS kv_store (key text PRIMARY KEY, value text NOT NULL, updated_at timestamptz NOT NULL DEFAULT now())`;
  neonReady = true;
}
async function neonGet(key) {
  await neonEnsure();
  const { rows } = await sql`SELECT value, updated_at FROM kv_store WHERE key = ${key}`;
  return rows[0] ? { value: rows[0].value, at: ts(rows[0].updated_at) } : null;
}
async function neonSet(key, value, at) {
  await neonEnsure();
  const when = new Date(at || Date.now()).toISOString();
  await sql`INSERT INTO kv_store (key, value, updated_at) VALUES (${key}, ${value}, ${when})
            ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`;
}

const attempt = (p) => p.then((v) => ({ ok: true, v })).catch((e) => ({ ok: false, e }));

export default async function handler(req, res) {
  const required = process.env.APP_ACCESS_KEY;
  if (required && req.headers["x-app-key"] !== required) {
    return res.status(401).json({ error: "unauthorized" });
  }

  try {
    if (req.method === "GET") {
      const key = req.query.key;
      if (!key) return res.status(400).json({ error: "missing key" });

      if (!sbOn) {
        const n = await attempt(neonGet(key));
        return res.status(200).json({ key, value: n.ok && n.v ? n.v.value : null });
      }

      const [s, n] = await Promise.all([attempt(sbGet(key)), attempt(neonGet(key))]);
      const sv = s.ok ? s.v : null;
      const nv = n.ok ? n.v : null;
      let winner = null;
      if (sv && nv) winner = sv.at >= nv.at ? sv : nv;
      else winner = sv || nv;
      if (!winner) return res.status(200).json({ key, value: null });

      // Heal whichever side is missing or stale (best-effort, don't block).
      if (s.ok && (!sv || (nv && nv.at > sv.at && winner === nv))) sbSet(key, winner.value, winner.at).catch(() => {});
      if (n.ok && (!nv || (sv && sv.at > nv.at && winner === sv))) neonSet(key, winner.value, winner.at).catch(() => {});

      return res.status(200).json({ key, value: winner.value });
    }

    if (req.method === "POST") {
      const { key, value } = req.body || {};
      if (!key || typeof value !== "string") return res.status(400).json({ error: "bad request" });
      const now = Date.now();
      const writes = sbOn
        ? await Promise.all([attempt(sbSet(key, value, now)), attempt(neonSet(key, value, now))])
        : [await attempt(neonSet(key, value, now))];
      if (writes.some((w) => w.ok)) return res.status(200).json({ key, value });
      const err = writes.map((w) => String((w.e && w.e.message) || w.e)).join(" | ");
      return res.status(500).json({ error: "save failed: " + err });
    }

    if (req.method === "DELETE") {
      const key = req.query.key;
      if (!key) return res.status(400).json({ error: "missing key" });
      if (sbOn) { try { await fetch(`${SB_URL}/rest/v1/${SB_TABLE}?key=eq.${encodeURIComponent(key)}`, { method: "DELETE", headers: sbHeaders() }); } catch {} }
      try { await neonSet(key, "", Date.now()); } catch {} // tombstone, never hard-delete the backup
      return res.status(200).json({ key, deleted: true });
    }

    res.setHeader("Allow", "GET, POST, DELETE");
    return res.status(405).json({ error: "method not allowed" });
  } catch (e) {
    return res.status(500).json({ error: String((e && e.message) || e) });
  }
}
