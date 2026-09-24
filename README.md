# Lobby Directory

Tenant directories for lobby screens, replacing Yodeck and Wix. Hosted on Netlify, with accounts and data in Supabase. Each screen is a Raspberry Pi 4 running Chromium full screen.

## Pages

| Address | Who | What |
|---|---|---|
| `/login.html` | everyone | Sign in, forgotten password, and setting a password from an invitation or reset email |
| `/console.html` | signed in | Screens (status, search, layout), Buildings, People, and Accounts (1Point only) |
| `/edit.html?d=…` | signed in | Edit one directory's tenants, plus its building's shared settings, with a live preview |
| `/?device=<serial>` | lobby screens | What a Pi shows: whichever screen the console assigns it to |
| `/?screen=ppi-2s` | lobby screens | A fixed screen. Older screens use `?site=landmark-center`, which still works |

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
| `RESEND_API_KEY` | **Yes** | For alert emails (Resend). Without it, alerts are only logged |
| `ALERT_EMAIL_TO` | No | Who gets alerts, comma-separated |
| `ALERT_EMAIL_FROM` | No | Sender, e.g. `Directory <alerts@1pointusa.com>` (must be a verified Resend domain) |

`ADMIN_PASSWORD` is no longer used and can be deleted once everyone signs in with their own login.

## Setting up a screen (Raspberry Pi)

On a freshly flashed Pi (Raspberry Pi OS with desktop, 64-bit), open Terminal and run:

```
curl -fsSLO https://1pdirectory.netlify.app/pi/setup-kiosk.sh
sudo bash setup-kiosk.sh
sudo reboot
```

The Pi opens `/?device=<its serial number>` and installs the agent. Then:

- **A Pi from the Yodeck report** recognizes itself by serial and shows its screen straight away.
- **A new Pi** shows "New display" with its serial, and appears under **Screens → New devices** in the console. Pick its screen there and it switches within a minute.

Options: `--rotate 270` if the picture is upside down, `--connect` for Raspberry Pi Connect, `--no-agent` to skip the agent, and `--url` to pin a fixed screen address the old way.

## Remote management (the agent)

Each Pi runs a small agent (`public/pi/agent.py`) that checks in every minute over HTTPS. The Pi always makes the connection, so no ports are opened. It reports:

- temperature, power (under-voltage), uptime, storage and IP address
- whether the browser is running
- a small screenshot every 5 minutes

Pi health is a 1Point service tool. Owner users see only each screen's Online/Offline dot. The server refuses them all device information, not just the console.

In the console, the **Pi** button on each screen offers Identify, Reload screen, Take screenshot, Reboot Pi and Update agent. Under **More** are Reset device key, Switch off, and Unassign.

**Health tab:** every Pi on one page, with problems sorted to the top. It shows:

- uptime today, over 7 days and over 30 days
- power dips, current and peak temperature, and browser outages
- IP address, agent version, and last check-in

It filters by account and exports a CSV, for customer service reports.

Uptime comes from a daily summary for each Pi (`device_daily`), kept for 400 days. A new Pi's uptime counts from its first check-in, so it isn't penalized for time before it was installed.

Only those fixed actions exist, and the agent can't run anything else. Actions not picked up within an hour are dropped rather than run late.

**Alerts:** every 10 minutes the site checks each Pi. It sends one email when a Pi goes offline, reports under-voltage, or runs at 80°C or hotter, and another when that clears.

**Reflashed a Pi?** If its log says the key doesn't match, use **Reset device key** in the console. It re-enrolls on its next check-in.

## Tests

```
npm install
npm test                      # server functions, against a fake Supabase
node --import ./tests/register-stub.mjs tests/test-server.mjs   # the whole site locally, with sample logins
```

Local sample logins: `scot@1pointusa.com / admin-pass`, `leighann@barber.test / owner-pass`, `editor@barber.test / editor-pass`.

## Files

```
public/             screen (index.html, display.*), sign-in, console (+ console-devices.js), editor, shared auth.js
netlify/functions/  screen, heartbeat, users, migrate, config, weather, news, agent, devices, alerts
netlify/lib/        Supabase client, RSS reader, shared helpers
supabase/           database schema, starting data, setup guide
migration/          the Yodeck/Wix transcription the starting data was built from
public/pi/          setup-kiosk.sh and agent.py (served by the site so Pis can download them)
tests/              function tests, fake Supabase, local test server
```
