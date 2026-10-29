# 🗒️ Academy Stickies

A private, invite-only web app where academy members leave each other short sticky
notes — **how they'd describe you** and **what you're great at professionally** —
signed or anonymous. Built on **Cloudflare Pages** with **D1** (data), **R2**
(avatars + sticky photos), and **Cloudflare Email Sending** (magic-link sign-in).
Designed to feel like the macOS **Stickies** app crossed with iOS Human Interface
Guidelines (SF typography, translucent materials, light/dark, grouped forms).

## Features

- **Magic-link auth** — each member signs in via a unique link emailed to their
  academy address; a signed, HttpOnly session cookie keeps them logged in.
- **Recipient-controlled walls** — private by default; each member can opt to make
  their wall visible to the academy.
- **Editable profiles** — each member can rewrite their own profile (name, tagline,
  intro, free-form sections and links) from their wall; a later cohort re-import
  leaves edited profiles untouched.
- **Signed or anonymous** stickies — anonymous notes store *no* author id, so
  anonymity is guaranteed by storage, not just hidden in the UI.
- **Avatars + photos** — profile photos and optional per-sticky images, stored in R2.
- **macOS-Stickies aesthetic** — colored paper notes, spring sheet animations,
  SF-symbol-style icons, full dark mode, reduced-motion + a11y support.

## Tech

| Layer     | Choice |
|-----------|--------|
| Hosting   | Cloudflare Pages (static SPA) |
| API       | Pages Functions + [Hono](https://hono.dev) (`functions/api/[[route]].ts`) |
| Frontend  | Vite + Preact + TypeScript, hand-rolled hash router, custom CSS design system |
| Data      | Cloudflare D1 (`DB`) |
| Media     | Cloudflare R2 (`MEDIA`) |
| Email     | Cloudflare Email Sending REST API |

## Prerequisites

- Node 22.13+ (wrangler 4 requires 22; the test suite's in-memory SQLite via `node:sqlite` only runs unflagged from 22.13) and a Cloudflare account (`npx wrangler login`).
- **For email:** a domain in your Cloudflare account, onboarded for sending
  (`npx wrangler email sending enable <domain>` — adds SPF/DKIM/DMARC; automatic
  if the domain uses Cloudflare DNS), plus a Cloudflare API token scoped to
  *Send Email*. Without a domain, skip email and hand out links from `npm run links`.

## Setup

```bash
npm install
cp .dev.vars.example .dev.vars      # then fill in SESSION_SECRET (openssl rand -base64 48)

# Create the Cloudflare resources (once):
npx wrangler d1 create stickies-db          # paste database_id into wrangler.toml
npx wrangler r2 bucket create stickies-media

# Apply the schema, then the numbered migrations under migrations/ in order
# (migrate1 … migrate9) — each adds a later feature's columns/tables:
npm run db:local                    # local dev database
npm run db:remote                   # deployed database
npm run migrate9:local              # …through migrate9 (note notifications); :remote for prod

# Add your people to seed/roster.json, then load them + generate links:
npm run seed                        # local   (npm run seed:remote for prod)
npm run links                       # prints each member's magic link
```

## Develop

```bash
npm run dev        # Vite build --watch + wrangler pages dev --live-reload
                   # → app + API + D1/R2 on one origin: http://localhost:8788
```

Vite rebuilds on save and the browser live-reloads; `wrangler pages dev` serves the
built SPA plus the `functions/` API with your D1/R2 bindings and `.dev.vars` secrets.
Open a member's magic link from `npm run links` to sign in (the link sets your
session cookie and drops you on the roster).

For a one-off production-style serve without the watcher: `npm run serve`.

## Email the links

```bash
# Local roster, dry run (prints who would be emailed):
npm run invite -- --dry-run

# Send for real (needs BREVO_API_KEY, EMAIL_FROM in .dev.vars):
npm run invite

# Production roster with the live site URL:
npm run invite:remote -- --site=https://stickies.yourdomain.com
```

## Deploy (Makefile)

The site runs on its Cloudflare Pages link — `https://<project>.pages.dev` — so there's
no custom domain to set up. `make help` lists every target; the typical flow:

```bash
make login      # authenticate wrangler (once)
make setup      # deps + create Pages project / D1 / R2 + schema + SESSION_SECRET
make deploy     # build + deploy  →  https://academy-stickies.pages.dev
make seed       # load seed/roster.json into prod D1
make links      # print each member's magic link (pointing at the Pages URL)
```

Pick a different project name (and therefore URL) with `PROJECT=`:

```bash
make deploy PROJECT=my-academy      # → https://my-academy.pages.dev
```

`make setup` auto-wires the new D1 `database_id` into `wrangler.toml`. Production needs
**no** `SITE_URL` — the API uses the request origin (your pages.dev link) for magic-link
redirects, and `make links` / `make invite` point links there via `--site`.

### Email (optional)

Email goes out through [Brevo](https://www.brevo.com) — **no domain required.** Brevo's
free tier sends 300 emails/day from a single *verified sender address*, so a Gmail you
own works fine. One-time setup:

1. Create a free Brevo account.
2. **Senders, Domains & Dedicated IPs → Senders → Add a sender** — enter the address you
   want links to come from (e.g. your Gmail) and click the confirmation email Brevo sends.
3. **SMTP & API → API Keys → Generate a new API key** (starts with `xkeysib-`).

```bash
# Enable the in-app "resend my link" endpoint on the deployed site:
make secrets-email BREVO_API_KEY=xkeysib-... EMAIL_FROM=you@gmail.com

# Blast everyone their link from your machine (reads the same vars from .dev.vars,
# or pass them on the command line):
make invite
```

Recipients see the mail from your verified address (Gmail may add a small "via brevo.com").
When you later get a domain, verify it in Brevo — or switch back to native Cloudflare
Email Sending — for a cleaner From with no "via" tag.

Without email, just share the output of `make links`.

## Project layout

```
functions/api/[[route]].ts   Hono API (auth, members, stickies, media, email)
lib/                         auth (session crypto), email, media validation
shared/types.ts              types shared by API + frontend
src/                         Preact SPA (views, components, design-system CSS)
schema.sql                   D1 schema
seed/roster.json             the roster you edit
scripts/                     seed / links / invite (via wrangler + Email Sending)
```

## Test

```bash
npm run test        # session sign/verify, image + email validation
npm run typecheck   # frontend, functions, and scripts
```

## Security notes

- Session cookie is HttpOnly + Secure (on HTTPS) + SameSite=Lax, holding an
  HMAC-signed `memberId.expiry` — rotate `SESSION_SECRET` to revoke everyone.
- Login tokens are 256-bit and unique per member; treat magic links like passwords.
- User text is rendered via Preact (auto-escaped); API validates lengths + upload
  types/sizes; private-wall sticky photos are gated by the same visibility rule.
