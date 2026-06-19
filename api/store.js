import { sql } from "@vercel/postgres";

// Serverless key/value store backed by Vercel Postgres (Neon).
// The whole app state is one JSON document, saved under a single key, so a
// simple (key, value) table is all we need to share data across every
// device and keep it permanently.

let ensured = false;
async function ensureTable() {
  if (ensured) return;
  await sql`CREATE TABLE IF NOT EXISTS kv_store (
    key        text PRIMARY KEY,
    value      text NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now()
  )`;
  ensured = true;
}

export default async function handler(req, res) {
  // Optional shared-key guard. Active only when APP_ACCESS_KEY is set on the
  // server; the client sends the matching VITE_APP_ACCESS_KEY as a header.
  const required = process.env.APP_ACCESS_KEY;
  if (required && req.headers["x-app-key"] !== required) {
    return res.status(401).json({ error: "unauthorized" });
  }

  try {
    await ensureTable();

    if (req.method === "GET") {
      const key = req.query.key;
      if (!key) return res.status(400).json({ error: "missing key" });
      const { rows } = await sql`SELECT value FROM kv_store WHERE key = ${key}`;
      return res.status(200).json({ key, value: rows[0] ? rows[0].value : null });
    }

    if (req.method === "POST") {
      const { key, value } = req.body || {};
      if (!key || typeof value !== "string") {
        return res.status(400).json({ error: "bad request" });
      }
      await sql`INSERT INTO kv_store (key, value, updated_at)
                VALUES (${key}, ${value}, now())
                ON CONFLICT (key) DO UPDATE
                  SET value = EXCLUDED.value, updated_at = now()`;
      return res.status(200).json({ key, value });
    }

    if (req.method === "DELETE") {
      const key = req.query.key;
      if (!key) return res.status(400).json({ error: "missing key" });
      await sql`DELETE FROM kv_store WHERE key = ${key}`;
      return res.status(200).json({ key, deleted: true });
    }

    res.setHeader("Allow", "GET, POST, DELETE");
    return res.status(405).json({ error: "method not allowed" });
  } catch (e) {
    return res.status(500).json({ error: String((e && e.message) || e) });
  }
}
