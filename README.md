# Lobby Directory

Tenant directories for lobby screens, replacing Yodeck and Wix. Hosted on Netlify, with accounts and data in Supabase. Each screen is a Raspberry Pi 4 running Chromium full screen.

## Pages

| Address | Who | What |
|---|---|---|
| `/login.html` | everyone | Sign in, forgotten password, and setting a password from an invitation or reset email |
| `/console.html` | signed in | Screens (status, search, layout), Buildings, People, and Accounts (1Point only) |
| `/edit.html?d=…` | signed in | Edit one directory's tenants, plus its building's shared settings, with a live preview |
| `/?screen=ppi-2s` | lobby screens | What a screen shows. Older screens use `?site=landmark-center`, which still works |

What each person sees is enforced by the database (see `supabase/01-schema.sql`):

- **1Point admin:** everything. Creates accounts, buildings, directories and screens, and invites anyone.
- **Account admin:** edits their own buildings, and invites or removes their own people.
- **Editor:** edits their own buildings only.

## Netlify environment variables

| Name | Secret | Purpose |
|---|---|---|
| `SUPABASE_URL` | No | Supabase project URL |
| `SUPABASE_ANON_KEY` | No | Supabase publishable (or legacy anon) key |
| `SUPABASE_SERVICE_KEY` | **Yes**, Production + Functions only | Supabase secret (or legacy service_role) key |
| `NWS_CONTACT` | No | Email address for the National Weather Service |
| `NEWS_FEEDS`, `NEWS_BLOCKLIST` | No | Optional news settings |

`ADMIN_PASSWORD` is no longer used and can be deleted once everyone signs in with their own login.

## Setting up a screen

1. In the console, open **Screens → Settings** and note the screen address (for example `ppi-3n`), or add a new screen.
2. On the Pi: `sudo bash setup-kiosk.sh --url "https://1pdirectory.netlify.app/?screen=ppi-3n"` (see `pi/`).
3. The screen shows as **Online** in the console within 5 minutes.

The layout (portrait, landscape, or automatic) is set per screen in the console. If it doesn't match how the TV is being driven, the page turns itself to fit.

## Tests

```
npm install
npm test                      # server functions, against a fake Supabase
node --import ./tests/register-stub.mjs tests/test-server.mjs   # the whole site locally, with sample logins
```

Local sample logins: `scot@1pointusa.com / admin-pass`, `leighann@barber.test / owner-pass`, `editor@barber.test / editor-pass`.

## Files

```
public/             screen (index.html, display.*), sign-in, console, editor, shared auth.js
netlify/functions/  screen, heartbeat, users, migrate, config, weather, news
netlify/lib/        Supabase client, RSS reader, shared helpers
supabase/           database schema, starting data, setup guide
migration/          the Yodeck/Wix transcription the starting data was built from
pi/                 setup-kiosk.sh
tests/              function tests, fake Supabase, local test server
```
