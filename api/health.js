import { sql } from "@vercel/postgres";

// Storage health check: reports whether each database is reachable and
// whether the app's saved data is present. Returns metadata only — never
// member data and never credential values.
//
//   GET /api/health

const SB_URL = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const STORE_KEY = "wellness:store:v1";
const short = (e) => String((e && e.message) || e).slice(0, 200);
const counts = (raw) => {
  try {
    const s = JSON.parse(raw);
    const months = s.payments && typeof s.payments === "object" ? Object.keys(s.payments) : [];
    let payments = 0;
    months.forEach((m) => Object.values(s.payments[m] || {}).forEach((p) => { payments += (p && Array.isArray(p.entries) ? p.entries.length : 0); }));
    return { members: Array.isArray(s.members) ? s.members.length : 0, paymentMonths: months.length, payments, visitsFor: s.visits ? Object.keys(s.visits).length : 0 };
  } catch { return { parseError: true }; }
};

export default async function handler(req, res) {
  const out = {
    configured: { supabaseUrl: !!SB_URL, supabaseKey: !!SB_KEY, appAccessKey: !!process.env.APP_ACCESS_KEY },
    supabase: { status: "not configured" },
    neon: { status: "unknown" },
    checkedAt: new Date().toISOString(),
  };

  if (SB_URL && SB_KEY) {
    try {
      const r = await fetch(`${SB_URL}/rest/v1/wellness_store?key=eq.${encodeURIComponent(STORE_KEY)}&select=value,updated_at`, {
        headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` },
      });
      if (!r.ok) out.supabase = { status: "error", httpStatus: r.status, detail: short(await r.text()) };
      else {
        const rows = await r.json();
        out.supabase = rows[0]
          ? { status: "ok", hasData: true, bytes: (rows[0].value || "").length, updatedAt: rows[0].updated_at, ...counts(rows[0].value) }
          : { status: "ok", hasData: false };
      }
    } catch (e) { out.supabase = { status: "unreachable", detail: short(e) }; }
  }

  try {
    const { rows } = await sql`SELECT value, length(value) AS bytes, updated_at FROM kv_store WHERE key = ${STORE_KEY}`;
    out.neon = rows[0]
      ? { status: "ok", hasData: true, bytes: rows[0].bytes, updatedAt: rows[0].updated_at, ...counts(rows[0].value) }
      : { status: "ok", hasData: false };
  } catch (e) { out.neon = { status: "error", detail: short(e) }; }

  const writable = out.supabase.status === "ok" || out.neon.status === "ok";
  res.setHeader("Cache-Control", "no-store");
  return res.status(200).json({ savingShouldWork: writable, ...out });
}
