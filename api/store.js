import { sql } from "@vercel/postgres";

// Shared key/value store for the whole app state (one JSON document per key).
//
// Storage strategy (non-destructive by design):
//   * Supabase is the primary store once configured.
//   * The original Vercel Postgres (Neon) database is KEPT as a durable
//     backup. Existing data there is auto-migrated into Supabase on first
//     read, and every write is mirrored back to Neon. Nothing is deleted.
//   * If Supabase is not configured (env vars missing), the app keeps working
//     exactly as before, straight off Neon.

const SB_URL = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const sbOn = !!(SB_URL && SB_KEY);
const SB_TABLE = "wellness_store";

const sbHeaders = () => ({ apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, "Content-Type": "application/json" });

async function sbGet(key) {
  const r = await fetch(`${SB_URL}/rest/v1/${SB_TABLE}?key=eq.${encodeURIComponent(key)}&select=value`, { headers: sbHeaders() });
  if (!r.ok) throw new Error("supabase get " + r.status);
  const rows = await r.json();
  return rows[0] ? rows[0].value : null;
}
async function sbSet(key, value) {
  const r = await fetch(`${SB_URL}/rest/v1/${SB_TABLE}`, {
    method: "POST",
    headers: { ...sbHeaders(), Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify({ key, value, updated_at: new Date().toISOString() }),
  });
  if (!r.ok) throw new Error("supabase set " + r.status + " " + (await r.text()));
}
async function sbDelete(key) {
  await fetch(`${SB_URL}/rest/v1/${SB_TABLE}?key=eq.${encodeURIComponent(key)}`, { method: "DELETE", headers: sbHeaders() });
}

// ---- Neon (original store) — durable backup / migration source ----
let neonReady = false;
async function neonEnsure() {
  if (neonReady) return;
  await sql`CREATE TABLE IF NOT EXISTS kv_store (key text PRIMARY KEY, value text NOT NULL, updated_at timestamptz NOT NULL DEFAULT now())`;
  neonReady = true;
}
async function neonGet(key) {
  try { await neonEnsure(); const { rows } = await sql`SELECT value FROM kv_store WHERE key = ${key}`; return rows[0] ? rows[0].value : null; } catch { return null; }
}
async function neonSet(key, value) {
  try { await neonEnsure(); await sql`INSERT INTO kv_store (key, value, updated_at) VALUES (${key}, ${value}, now()) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`; } catch {}
}

export default async function handler(req, res) {
  const required = process.env.APP_ACCESS_KEY;
  if (required && req.headers["x-app-key"] !== required) {
    return res.status(401).json({ error: "unauthorized" });
  }

  try {
    if (req.method === "GET") {
      const key = req.query.key;
      if (!key) return res.status(400).json({ error: "missing key" });

      if (sbOn) {
        let val = null;
        try { val = await sbGet(key); } catch (e) { val = undefined; } // undefined = supabase unreachable
        if (val != null) return res.status(200).json({ key, value: val });
        // Supabase empty or unreachable → consult Neon backup.
        const backup = await neonGet(key);
        if (backup != null) {
          if (val === null) { try { await sbSet(key, backup); } catch {} } // seed Supabase once (migration)
          return res.status(200).json({ key, value: backup });
        }
        return res.status(200).json({ key, value: null });
      }

      const val = await neonGet(key);
      return res.status(200).json({ key, value: val });
    }

    if (req.method === "POST") {
      const { key, value } = req.body || {};
      if (!key || typeof value !== "string") return res.status(400).json({ error: "bad request" });
      if (sbOn) {
        try { await sbSet(key, value); }
        catch (e) { return res.status(500).json({ error: "save failed: " + ((e && e.message) || e) }); }
        neonSet(key, value); // best-effort mirror to backup, don't block the response
      } else {
        await neonSet(key, value);
      }
      return res.status(200).json({ key, value });
    }

    if (req.method === "DELETE") {
      const key = req.query.key;
      if (!key) return res.status(400).json({ error: "missing key" });
      if (sbOn) { try { await sbDelete(key); } catch {} }
      await neonSet(key, ""); // keep a tombstone in backup rather than hard-deleting
      return res.status(200).json({ key, deleted: true });
    }

    res.setHeader("Allow", "GET, POST, DELETE");
    return res.status(405).json({ error: "method not allowed" });
  } catch (e) {
    return res.status(500).json({ error: String((e && e.message) || e) });
  }
}
