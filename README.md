# Bill Tracker

A bill-and-paycheck ledger: enter your pay schedule, bills, and savings accounts once, and it projects your checking balance forward paycheck by paycheck — flagging any pay period that would dip below a low-balance threshold. Ported from a long-running personal spreadsheet's macro logic.

Runs as a desktop app (Windows/macOS/Linux via Electron), an Android app (via Capacitor), or a self-hosted web app (Docker) — all from the same React codebase.

## Features

- **Projection & History** — every paycheck, its bills, and the running checking/savings balances, computed from each bill's own schedule (every paycheck, monthly, quarterly, annual, every N weeks, alternating months)
- **Actual corrections** — override any projected balance, bill amount, or pay amount once you know the real number; everything after it re-chains from that correction
- **Editing a bill's amount only affects the current and future pay periods** — past periods keep whatever was actually charged
- **Savings accounts** — tag a bill to auto-transfer into a savings account, tracked with its own running balance
- **Year-to-date report** — CSV export of every paycheck's gross/net/bills/balances for the year, optionally with a line item per bill paid
- **Cloud sync (optional)** — sign in with Supabase Auth (email/password or an emailed code) to sync data across your own devices; nothing is sent anywhere if you don't set this up
- **Dark mode**, CSV/JSON export/import, category management

## Getting started (development)

```
npm install
npm run dev
```

Opens at `http://localhost:5173`. Data is stored in `localStorage`; nothing else is required to try the app.

To load example data instead of starting blank: Settings → Data → Import → select `sample-data.json`.

### Cloud sync (optional)

Cloud sync is off unless both of these are set (copy `.env.example` to `.env` and fill in):

```
VITE_SUPABASE_URL=
VITE_SUPABASE_ANON_KEY=
```

You'll also need, in your own Supabase project:

1. Run `supabase/schema.sql` in the SQL editor — creates the `account_blobs` table and its row-level-security policy.
2. In Authentication → Email Templates, add `{{ .Token }}` to the **Confirm signup**, **Magic Link**, and **Reset Password** templates — the app emails a code rather than a clickable link (see the comments in `src/supabaseAuth.js` for why), and Supabase only includes the token in the email once the template references it.

## Building

| Target | Command | Output |
|---|---|---|
| Windows (installer + portable) | `npm run dist:win` | `release/` |
| Linux | `npm run dist:linux` | `release/` |
| macOS | `npm run dist:mac` | `release/` |
| Android (debug APK) | `npm run dist:android` | `android/app/build/outputs/apk/debug/app-debug.apk` |
| Docker image | `docker compose build` | local image, tagged `bill-tracker-bill-tracker` |

`VITE_SUPABASE_URL`/`VITE_SUPABASE_ANON_KEY` are baked into the bundle at build time (Vite), so `.env` must be filled in before building if you want cloud sync in the distributed build.

### Docker

```
docker compose up -d
```

Reads `.env` for `VITE_SUPABASE_URL`/`VITE_SUPABASE_ANON_KEY` (build args) and `AUTH_MODE`/`BASIC_AUTH_USER`/`BASIC_AUTH_PASS` (runtime). `AUTH_MODE=basic` (default) puts nginx Basic Auth in front of the app; `AUTH_MODE=none` turns that off — only do that once the app's own Supabase Auth sign-in is configured, or the deployment has no login gate at all.

For deploying a pre-built image (e.g. to CasaOS) without this repo's build context, see `docker-compose.casaos.yml` — it pulls from GHCR or loads from a `docker save` tarball instead of building from source.

## Downloads

Prebuilt Windows/Android/Docker artifacts are attached to each [GitHub Release](../../releases). The `.exe` files aren't code-signed, so Windows SmartScreen or your browser may flag them as an unrecognized publisher — verify the file's SHA256 against the release's `checksums.txt` before running it if you want to confirm nothing changed in transit.

## Project structure

```
src/App.jsx          Everything UI + projection-engine — components, schedule math, tabs
src/supabaseClient.js  Supabase client + isSyncConfigured
src/supabaseSync.js    Cloud sync (push/pull the account's data blob)
src/supabaseAuth.js    Sign-up/sign-in/password-reset (email/password + emailed codes)
electron/main.cjs     Electron main process (desktop build)
android/              Capacitor Android project
docker/               nginx config + Basic Auth entrypoint script for the Docker build
supabase/schema.sql   SQL to run once in your Supabase project for cloud sync
```
