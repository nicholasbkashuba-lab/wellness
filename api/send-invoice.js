// Sends an invoice/receipt email from the clinic's own domain via Resend.
//
// Required environment variables (set in Vercel):
//   RESEND_API_KEY  — from resend.com (Account → API Keys)
//   INVOICE_FROM    — a verified-domain sender, e.g.
//                     "First Rehabilitation <billing@yourdomain.com>"
// Optional:
//   INVOICE_REPLY_TO — reply-to address (e.g. the front-desk inbox)

export default async function handler(req, res) {
  const required = process.env.APP_ACCESS_KEY;
  if (required && req.headers["x-app-key"] !== required) {
    return res.status(401).json({ error: "unauthorized" });
  }
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "method not allowed" });
  }

  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.INVOICE_FROM;
  if (!apiKey || !from) {
    return res.status(500).json({ error: "Email is not configured yet. Set RESEND_API_KEY and INVOICE_FROM in Vercel." });
  }

  const { to, subject, html, text } = req.body || {};
  if (!to || !subject || (!html && !text)) {
    return res.status(400).json({ error: "Missing recipient, subject, or body." });
  }

  try {
    const payload = { from, to: Array.isArray(to) ? to : [to], subject };
    if (html) payload.html = html;
    if (text) payload.text = text;
    if (process.env.INVOICE_REPLY_TO) payload.reply_to = process.env.INVOICE_REPLY_TO;

    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      return res.status(502).json({ error: (data && (data.message || data.name)) || `Resend error ${r.status}` });
    }
    return res.status(200).json({ id: data.id || null, sent: true });
  } catch (e) {
    return res.status(500).json({ error: String((e && e.message) || e) });
  }
}
