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

## Important notes
- **Data is per-device.** This build stores everything in the browser's localStorage,
  so each device/browser has its own data and nothing syncs between them. Set up the
  tablet you'll actually use day to day, and back up via the in-app CSV exports.
- **The PIN login is a privacy lock, not real security.** It keeps casual eyes out and
  attributes check-ins, but it can be bypassed by someone with the device. For real
  accounts, encryption, shared data across devices, and automatic sending/billing,
  this needs the hosted version with a database + auth + an SMS/email service + Stripe.
- First load shows the setup screen to create a master passcode. Add per-staff PINs
  under Manage staff.
