# First Rehabilitation Inc. — Clinic Console

Wellness billing, member check-in, and staff scheduling. Built with React + Vite.

## Run locally
```bash
npm install
npm run dev
```

## Deploy to Vercel — pick one

### Option A — Vercel CLI (fastest)
```bash
npm i -g vercel      # one time
vercel               # from this folder; follow the prompts
vercel --prod        # promote to your production URL
```
Vercel auto-detects Vite (build: `vite build`, output: `dist`). No extra config needed.

### Option B — GitHub + Vercel dashboard (best for ongoing updates)
1. Push this folder to a new GitHub repo.
2. Go to vercel.com → Add New → Project → Import the repo.
3. Framework preset: **Vite** (auto-detected). Click Deploy.

### Option C — let Claude Code do it
Open this folder in Claude Code; its Vercel integration can deploy for you in one step.

## Shared data across all devices (required for multi-user)

Data is stored in a hosted Postgres database via the `/api/store` serverless
function, so every device and browser shares the same data and it persists
permanently. To turn this on, create the database once:

1. In Vercel, open the **wellness** project → **Storage** tab → **Create Database**.
2. Choose **Postgres** (Neon) → pick the region closest to your clinic → **Create**,
   then **Connect** it to this project. Vercel injects the `POSTGRES_URL`
   environment variables automatically.
3. **Redeploy** (Deployments → latest → ⋯ → Redeploy) so the new env vars take effect.

That's it — the app creates its own table on first use. Any data already entered
on a device (stored locally) is migrated up to the database the first time that
device loads against the live database.

### Optional: lock down the data API (recommended)
The `/api/store` endpoint is public by default. To keep casual visitors out, set a
shared key in **Settings → Environment Variables** (both to the same long random value):

- `APP_ACCESS_KEY` — checked by the server
- `VITE_APP_ACCESS_KEY` — baked into the frontend

Generate one with `openssl rand -hex 24`, then redeploy. See `.env.example`.

## Important notes
- **Until the database is connected, data is per-device.** Without the steps above the
  app falls back to the browser's localStorage (each device separate). After connecting,
  data is shared and permanent. Back up anytime via the in-app CSV exports.
- **Last write wins.** The whole console state is saved as one document, so if two
  people save edits at the exact same moment, the later save overwrites the earlier one.
  Fine for a front desk; not built for heavy simultaneous editing.
- **Not a substitute for real auth / HIPAA compliance.** The PIN is a privacy lock, and
  the optional API key is light obfuscation, not strong security — anyone with the app
  link and key can read/write. For regulated patient data you still need real per-user
  accounts, a host willing to sign a BAA, and audit logging.
- First load shows the setup screen to create a master passcode. Add per-staff PINs
  under Manage staff.
