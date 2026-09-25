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
| `/?screen=ppi-2s&view=1` | anyone | Looking at a screen (the console's **View** button). Shows the same thing but doesn't count as the screen checking in |
| `/` | anyone | A short note that no screen was chosen. (It used to show The Landmark Center.) |

Lobby screens check for changes every minute (`/api/screen`). The same check records the screen as online, and the directory is sent only when something has changed; otherwise the answer is "not modified". Only real screens record check-ins: the editor's preview, the console's View button and the bare address never do. `heartbeat` only serves screens still running display 2.0.0 and can be deleted a few days after the 2.1.0 deploy.

What each person sees is enforced by the database (see `supabase/01-schema.sql`):

- **1Point admin:** everything. Creates accounts, buildings, directories and screens, and invites anyone.
- **Account admin:** edits their own buildings, and invites or removes their own people.
- **Editor:** edits their own buildings only.

Owner users can't read a screen's hardware record (serial, MACs, IPs, the Yodeck snapshot): signed-in users may read only the screen columns listed in `supabase/06-trust.sql`, and 1Point sees hardware through the site's server.

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

- **A Pi from the Yodeck report** recognizes itself by serial and shows its screen straight away. Its agent, though, is refused until 1Point opens its **enrollment window**: in the console, **Pi → Open enrollment (24 hours)**, on install day, before or soon after the Pi starts. The agent keeps trying every minute, so it enrolls within a minute of the window opening. The window closes as soon as the Pi enrolls.
- **A new Pi** (not in the Yodeck report) enrolls on first contact, shows "New display" with its serial, and appears under **Screens → New devices** in the console. Check that the serial matches the one on the TV, then pick its screen there and it switches within a minute. No screenshot is kept for a Pi until it's assigned.

Rotation is automatic. Each time the Pi starts, it asks the site whether its screen is set to portrait or landscape in the console, and turns the picture to match. Portrait turns 90°. Landscape, new and unassigned Pis stay upright. Without internet it keeps its last answer. So after assigning a new Pi to a portrait screen, use **Pi → Reboot Pi** in the console to turn it. The Pi never reboots on its own; reboot scheduling will come to the console with maintenance windows.

SSH is switched off by setup (from the restart that finishes it), so the Pi opens no ports. The agent covers remote management. Use `--ssh` for a Pi that needs it, and re-run setup without `--ssh` to switch it off again.

Options: `--rotate 270` if a portrait picture is upside down (or `0`/`90` to fix it by hand), `--ssh` to leave SSH on, `--connect` for Raspberry Pi Connect, `--no-agent` to skip the agent, and `--url` to pin a fixed screen address the old way.

## Remote management (the agent)

Each Pi runs a small agent (`public/pi/agent.py`) that checks in once a minute over HTTPS, on a fixed schedule (a slow check-in never pushes the next one back). Results of console actions go out with the next scheduled check-in; a reboot's or an update's result is kept on the Pi until it's reported. Each check-in is a single database call (`supabase/05-tuning.sql`), because Netlify bills for the time a function spends waiting. The Pi always makes the connection, so no ports are opened. It reports:

- temperature, power (under-voltage), uptime, storage and IP address
- whether the browser is running
- a small screenshot every 5 minutes

Pi health is a 1Point service tool. Owner users see only each screen's Online/Offline dot. The server refuses them all device information, not just the console.

In the console, the **Pi** button on each screen offers Identify, Reload screen, Take screenshot, Reboot Pi and Update agent. The Pi actions appear only once the Pi has enrolled (the server refuses them before that). Under **More** are Reset device key, Switch off, and Unassign.

**Health tab:** every Pi on one page, with problems sorted to the top. It shows:

- uptime today, over 7 days and over 30 days
- power dips, current and peak temperature, and browser outages
- IP address, agent version, and last check-in

It filters by account and exports a CSV, for customer service reports.

Uptime comes from a daily summary for each Pi (`device_daily`), kept for 400 days. Each check-in credits the time since the Pi's previous one, if that was 3 minutes ago or less (`supabase/07-uptime.sql`), so small timing differences never show as downtime. A longer gap is an outage and earns nothing, so an outage reads up to a minute longer than it was, never shorter. A new Pi's uptime counts from its first check-in, so it isn't penalized for time before it was installed. A reboot (about a minute) counts as up.

Only those fixed actions exist, and the agent can't run anything else. Actions not picked up within an hour are dropped rather than run late.

**Alerts:** every 10 minutes the site checks each Pi. It sends one email when a Pi goes offline, reports under-voltage, or runs at 80°C or hotter, and another when that clears. A Pi's alert state is saved only after the email has gone out, so a failed send is retried on the next run, and problems that already exist are emailed once when the email settings are first added.

**Enrollment:** each Pi has its own key, stored hashed. A registered Pi with no key yet (from the Yodeck report, or after **Reset device key**) accepts its first key only while its enrollment window is open (24 hours, opened from **Pi** in the console). Anyone who knows a Pi's serial can't claim it outside that window.

**Reflashed a Pi?** If its log says the key doesn't match, use **Reset device key** in the console. That clears the key and opens the enrollment window for 24 hours; the Pi re-enrolls on its next check-in.

## Tests

```
npm install
npm test                      # server functions, against a fake Supabase
node --import ./tests/register-stub.mjs tests/test-server.mjs   # the whole site locally, with sample logins
bash tests/kiosk-rotation-test.sh    # the Pi's automatic rotation, against the local site (takes about 3 minutes)
python3 tests/agent-test.py          # the Pi's agent: schedule, command results, reboot and update (about 40 seconds)
```

Local sample logins: `scot@1pointusa.com / admin-pass`, `leighann@barber.test / owner-pass`, `editor@barber.test / editor-pass`.

## Files

```
public/             screen (index.html, display.*), sign-in, console (+ console-devices.js), editor, shared auth.js
netlify/functions/  screen, heartbeat, users, migrate, config, weather, news, agent, devices, alerts
netlify/lib/        Supabase client, RSS reader, shared helpers
supabase/           database schema (01 to 06, run in order), starting data, check queries, setup guide
migration/          the Yodeck/Wix transcription the starting data was built from
public/pi/          setup-kiosk.sh and agent.py (served by the site so Pis can download them)
tests/              function tests, fake Supabase, local test server
```
