# Lobby Directory

Tenant directories for lobby screens, replacing Yodeck and Wix. Hosted on Netlify, with accounts and data in Supabase. Each screen is a Raspberry Pi 4 running Chromium full screen.

## Pages

| Address | Who | What |
|---|---|---|
| `/login.html` | everyone | Sign in, forgotten password, and setting a password from an invitation or reset email |
| `/console.html` | signed in | Screens (status, search, layout), Buildings, People, and Accounts (1Point only) |
| `/tech.html` | 1Point | The technician page, sized for a phone: Identify, Reload screen, Reboot Pi, Layout, and Wi-Fi search and join. Add it to the phone's home screen |
| `/edit.html?d=…` | signed in | Edit one directory's tenants, plus its building's shared settings (address, logo, an owner or manager logo, background photo, contacts), with a live preview |
| `/?device=<serial>` | lobby screens | What a Pi shows: whichever screen the console assigns it to |
| `/?screen=ppi-2s` | lobby screens | A fixed screen. Older screens use `?site=landmark-center`, which still works |
| `/?screen=ppi-2s&view=1` | anyone | Looking at a screen (the console's **View** button). Shows the same thing but doesn't count as the screen checking in |
| `/` | anyone | A short note that no screen was chosen. (It used to show The Landmark Center.) |

Lobby screens check for changes every minute (`/api/screen`). The same check records the screen as online, and the directory is sent only when something has changed; otherwise the answer is "not modified". Only real screens record check-ins: the editor's preview, the console's View button and the bare address never do.

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
| `SMTP_HOST` | No | Company mail server for alert emails, e.g. `secure.emailsrvr.com` (Rackspace) |
| `SMTP_PORT` | No | `465` (encrypted from the start) or `587` (STARTTLS). Plain, unencrypted mail servers are refused |
| `SMTP_USER` | No | The mailbox alerts are sent from, e.g. `directory@1pointusa.com` |
| `SMTP_PASS` | **Yes** | That mailbox's password |
| `ALERT_EMAIL_TO` | No | Who gets alerts until recipients are added in the console (**Pi setup → Alert emails**), comma-separated |
| `ALERT_EMAIL_FROM` | No | Sender, e.g. `Lobby Directory <directory@1pointusa.com>`: the same mailbox as `SMTP_USER` (mail servers refuse other senders) |
| `RESEND_API_KEY` | **Yes** | Optional instead of the SMTP settings: Resend, used only when `SMTP_HOST` isn't set |

Without a way to send, alerts are only logged. Settings take effect at the next deploy (Deploys → Trigger deploy).

`ADMIN_PASSWORD` is no longer used and can be deleted once everyone signs in with their own login.

## Screens and cards (Raspberry Pi)

Every Pi runs from a **prepared card**, and every card is the same. A card carries no identity until it's in a Pi:
at every start the Pi builds its screen address from its own serial (`/?device=<serial>`), the agent makes its own key
for that Pi, and the Pi names itself after its serial on the network (e.g. `lobby-a4ae272d`). So any card works in
any Pi, and a tech can carry spares. Which screen a Pi shows is decided in the console, by serial.

Every card also carries every Wi-Fi network in the console's **Pi setup** tab that's marked **Put on newly prepared
cards** (1Point only). A Pi joins whichever saved network is in range, and a network cable always wins. Passwords can
be replaced in the console but never read back. Because every card holds those passwords, treat cards and the card
image like a password. Networks saved from the technician page stay off cards (see The technician page).

### Preparing cards (office, once per batch)

1. **Save the Wi-Fi** for every building on Wi-Fi, plus the office network if Pis are tested there: console,
   **Pi setup → Add Wi-Fi network**.
2. **Flash one card** with Raspberry Pi Imager: Raspberry Pi OS (64-bit, with desktop). In Imager's settings, set the
   user name and password, the Wi-Fi country (US) and time zone. Wi-Fi is only needed if the bench Pi has no cable;
   the bench's own network is removed from the card at the end.
3. **Boot it in any Pi** (the bench Pi). In the console, **Pi setup → Get a prepare code**, then in the Pi's Terminal,
   at its own keyboard, run the two commands the console shows:

   ```
   curl -fsSLO https://1pdirectory.netlify.app/pi/setup-kiosk.sh
   sudo bash setup-kiosk.sh --prepare --code ABCD-EFGH
   ```

   It installs everything, saves the Wi-Fi, clears everything that belongs to the bench Pi (machine ID, logs,
   browser data, keys, the bench's own Wi-Fi) and powers off. **Don't start that card again before copying it.**
4. **Copy the card to an image file** on a Windows PC with Win32 Disk Imager: **Read** (not Write), to a file like
   `lobby-card-2026-10.img`. The file is the full size of the card. Win32 Disk Imager lists only drives with a
   letter; if the card doesn't appear, give its small FAT32 partition (bootfs) a letter in Disk Management
   (right-click, Change Drive Letter and Paths, Add), leave the large partition alone, cancel any "format" prompt,
   and reopen Win32 Disk Imager.
5. **Optional but recommended: shrink the image** so it fits any 32 GB card (two "32 GB" cards can differ slightly,
   and a full-size image won't write to a smaller one). In WSL (Ubuntu on Windows: `wsl --install -d Ubuntu` in an
   admin PowerShell, then restart), with
   [PiShrink](https://github.com/Drewsif/PiShrink): `sudo pishrink.sh lobby-card-2026-10.img`. A shrunk card grows
   back to fill its card at first start. Skip this only if every card is the same brand and model.
6. **Write the image to every card** with Raspberry Pi Imager: **Choose OS → Use custom**, pick the image, and when it
   asks about OS customisation, choose **No** (the card is already set up). No card is named or labeled.
7. **Test one card in any Pi** before a field visit: within a couple of minutes its serial appears under
   **Screens → New devices** (or, for a pre-registered Pi, it shows its screen).

When a saved network changes, cards already made keep the old one: prepare a new image, or (later) change it from
the console once Pi settings are built.

### In the field

- **Yodeck changeover** (a pre-registered Pi): open the Pi's enrollment window in the console (**Pi → Open
  enrollment**), swap in a prepared card, and power on. It shows its screen straight away and enrolls within a minute.
  Keep the old Yodeck card bagged and labeled at the screen as the rollback.
- **A new Pi** (not in the Yodeck report): power on with a prepared card. It shows "New display" with its serial and
  appears under **Screens → New devices**. Check the serial matches the one on the TV, then assign it to its screen.
- **A bad card, same Pi:** swap in a spare card, then **Pi → More → Reset device key** in the console (that opens the
  enrollment window). The Pi re-enrolls within a minute.
- **A bad Pi:** put a card in the replacement Pi. Its serial appears under New devices: choose the screen in its
  dropdown (screens that already have a Pi are listed as "replaces Pi …"; confirm, and the old Pi is unassigned and
  moves to New devices).
- **A Pi that turned up before it was meant to** (a test Pi, a stray): **Remove this Pi from the list**, the last
  choice in its New devices dropdown. Its record and history are deleted. If it's still switched on, it checks in
  again and reappears within a minute, so power it off or wipe its card first.

### The case button and status light

1Point's own cases have a button and a status light. Wiring (any Pi; a Pi without them is unaffected):

- **Button:** a momentary switch between **GPIO3 (pin 5)** and **ground (pin 6)**. No resistor.
- **Light:** an LED from **GPIO17 (pin 11)** through a **330 Ω to 1 kΩ** resistor to **ground (pin 9)**.

| Button | |
|---|---|
| Press, Pi shut down | Powers on |
| Short press | Nothing |
| Hold **3 s**, let go | Safe shutdown (before pulling power or the card) |
| Hold **10 s**, let go | **Network reset:** Wi-Fi joined in the field is forgotten (the card's own networks and a cable stay), the Pi forgets it has been online, and restarts. On a card network if one's in range; otherwise it offers field Wi-Fi setup |
| Hold 30 s or more | Cancelled (a stuck or leaned-on button does nothing) |

While it's held, the board's green light and the case light blink: slowly past 3 s, fast past 10 s, so let go when it
blinks fast for a reset. The rest of the time the case light shows the Pi's state: **steady** online, **slow blink**
offline, **double blink** in Wi-Fi setup.

The button never touches the Pi's key, enrollment or screen: those stay console actions. Setup turns both on by
default (`--no-button`, `--led-gpio N|none` to change them); a Pi already in the field gets them with **Update Pi**
(agent 1.7.0), and the button works from the restart that finishes it.

### Field Wi-Fi setup

A Pi that has never reached the site — wrong or missing Wi-Fi, no cable yet — offers its own setup instead of
sitting on a blank screen. No new card and no console visit needed:

1. The Pi's screen shows a hotspot name (`Directory-Setup-<last 4 of serial>`) and an 8-digit code. Both stay the
   same for that Pi, so a phone that has joined it before still has the right code.
2. From a phone: join that Wi-Fi network with the code. The setup page opens by itself, like a hotel Wi-Fi sign-in
   page; if it doesn't, open `http://10.42.0.1` in the phone's browser (the TV shows the address). If the phone says
   the network has no internet, choose to stay connected. A keyboard at the Pi works too, on the same page.
3. Pick a network (or type a hidden one's name), enter its password, and submit. Not listed yet? **Search again**
   (the page also searches by itself every 15 seconds while it has found nothing). The Pi joins it, confirms it can
   reach the site, and starts the directory normally. A wrong password or a network that can't reach the site is
   reported on the same page so it can be retried, and so is a locked network chosen without its password.

This only happens for a Pi that's never gotten online at all. A Pi that's worked before and just loses its network
keeps the quieter behavior below (cached content, "Reconnecting…") — it never puts up a surprise hotspot on a
screen that's already working; holding the case button 10 seconds (a network reset) brings it back on purpose.
Proven on a real Pi 4 (2026-10-01): it lists nearby networks while hosting the hotspot.

### The technician page

`/tech.html`, for 1Point staff in the field, on a phone (**Share → Add to Home Screen** on an iPhone, **Add to home
screen** in Chrome on Android, and it opens like an app). It signs in with the same 1Point login as the console;
anyone else is told it's for 1Point technicians. Pick a screen from the list (or search), and its page shows the Pi's
status in plain words, then:

- **Identify**, **Reload screen**, **Reboot Pi**.
- **Layout:** choose one and **Save and restart Pi**, so the picture turns now (dark for about a minute). With no
  enrolled Pi, it just saves the layout.
- **Wi-Fi:** **Search for networks** lists what the Pi can pick up, strongest first, and which one it's on. Tap one,
  type its password, **Join**; or **Join a network that isn't listed** for a hidden one. If the Pi can't join it, or
  joins but can't reach the site within a minute, it drops it and goes back to the network it had, and the page says
  why. With a network cable plugged in, the cable stays in charge and the new Wi-Fi is its backup. The password goes
  to the Pi once and is then deleted from the database (about a minute at most); it's never shown back, and the
  audit log records only the network's name.
- **Save for other screens:** tick it when joining, and once the Pi reports the join worked, the network is saved
  (labelled with the building). Every other Pi that can see it then shows it as **Saved**: one tap joins it, and the
  server supplies the password, so no one types it again and the phone never receives it. **Type a different
  password** (with the tick) updates a saved password that has changed. Networks saved this way are **never put on
  cards**; they're listed in the console's **Pi setup** as saved from the technician page, and the office can remove
  one, or tick **Put on newly prepared cards** for a network many Pis need (a very large site).

**Installing on Wi-Fi, the usual way:** at the building's first Pi, join its network from the technician page with
**Save for other screens** ticked; at every other Pi there, tap it under Saved. Cards stay the same everywhere. Put a
network on the cards themselves only for a very large installation.

Wi-Fi needs agent 1.6.0 or newer (**Pi → Update agent** in the console once); until then the page says so. Reset
device key, Unassign and the updates stay in the console.

### Unattended after a power cut

A Pi needs no one on site after a power cut, whatever comes back first:

- **The TV:** the Pi keeps the TV switched on and showing the Pi, over HDMI-CEC, and reports its state (On, standby,
  not answering) to the Pi panel and the Health tab, where a TV that's off shows as a problem. At start it tries every 15 seconds
  for 5 minutes (a TV can come up after the Pi), then checks every 2 minutes, so a TV switched off, or one that lost
  power on its own, comes back on. The TV's CEC setting must be on (Anynet+ on Samsung, SimpLink on LG, Bravia Sync
  on Sony). If a TV has a "power on after power loss" setting, set it to On as well. `--no-tv` leaves the TV alone.
- **The picture:** HDMI 0 always sends a picture at 1080p, even if no TV was detected at start, and the kiosk puts the
  rotation back within 10 seconds if a TV powering up resets it.
- **No network** (a Pi that's been online before): the screen shows the directory and news it last received, with
  "Showing saved information. Reconnecting…" at the bottom. Weather shows for up to 3 hours, then disappears. The
  time and date are hidden until the Pi has reached the site since it started: a Pi 4 has no battery-backed clock, so
  after a power cut its time is wrong until it's online. The clock follows the site's own time, so it's right even
  where a building blocks the usual time service (NTP). Everything returns within about a minute of the network. A
  Pi that's never been online instead offers field Wi-Fi setup (above).
- **No mouse pointer** on screen, with or without a mouse (an invisible pointer theme).
- **A quiet restart:** no rainbow square, Raspberry Pi logo, boot text or desktop picture; the TV stays black until
  the directory appears (about a minute).

### Updating Pis in the field

Nothing needs a site visit or a new card:

- **What the screen shows** (the display's code) comes from the site: every Pi reloads it at 3 a.m., or at once with
  **Pi → Reload screen**. Content (tenants, logos, photos) is live within a minute of saving.
- **Pi → Update Pi** (1Point): the Pi downloads the latest setup from the site and re-applies it in place, with the
  options it was set up with (`/etc/lobby-setup.conf`), installs Raspberry Pi OS updates, then restarts. Its
  identity, key and Wi-Fi stay as they are. The screen keeps running during the update (5 to 20 minutes) and is dark
  for about a minute at the restart. The result ("Updated; restarting." or the error) shows under Recent actions; a
  failed update doesn't restart the Pi. Try one Pi before the rest.
- **Pi → Update agent** installs just the latest agent, without a restart.

New card images are only for new cards (installs and spares). A spare made from an older image catches up with one
Update Pi. Saved Wi-Fi changes still reach a Pi only on a new card (see the roadmap).

### Setting up one Pi directly (instead of a prepared card)

On a freshly flashed Pi, open Terminal and run the same commands without `--prepare` (the code is only needed to
save the Wi-Fi; a wired Pi can leave out `--code`), then `sudo reboot`.

Rotation is automatic. Each time the Pi starts, it asks the site how its screen's **Layout** is set in the console, and turns the picture to match: Portrait 90°, **Portrait (turned the other way)** 270° for a portrait TV hung the other way round, **Landscape (upside down)** 180°; landscape, new and unassigned Pis stay upright. Without internet it keeps its last answer. So after assigning a Pi or changing a Layout, use **Pi → Reboot Pi** to turn it. The Pi never reboots on its own; reboot scheduling will come to the console with maintenance windows.

SSH is switched off by setup (from the restart that finishes it), so the Pi opens no ports. The agent covers remote management. Use `--ssh` for a Pi that needs it, and re-run setup without `--ssh` to switch it off again.

Options (`sudo bash setup-kiosk.sh --help` lists them all): `--rotate 0|90|180|270` to fix the turn by hand (for good; the console's Layout is the usual way), `--ssh` to leave SSH on, `--no-tv` to leave the TV alone, `--no-button` and `--led-gpio N|none` for the case button and light, `--connect` for Raspberry Pi Connect, `--no-agent` to skip the agent, and `--url` to pin a fixed screen address the old way.

## Remote management (the agent)

Each Pi runs a small agent (`public/pi/agent.py`) that checks in once a minute over HTTPS, on a fixed schedule (a slow check-in never pushes the next one back). Results of console actions go out with the next scheduled check-in; a reboot's or an update's result is kept on the Pi until it's reported. Each check-in is a single database call (`supabase/05-tuning.sql`), because Netlify bills for the time a function spends waiting. The Pi always makes the connection, so no ports are opened. It reports:

- temperature, power (under-voltage), uptime, storage and IP address
- whether the browser is running
- a small screenshot every 5 minutes

Pi health is a 1Point service tool. Owner users see only each screen's Online/Offline dot. The server refuses them all device information, not just the console.

In the console, the **Pi** button on each screen offers Identify, Reload screen, Take screenshot, Reboot Pi, Update agent and Update Pi (see Updating Pis in the field). The technician page adds Wi-Fi search and join (agent 1.6.0). The Pi actions appear only once the Pi has enrolled (the server refuses them before that). Under **More** are Reset device key, Switch off, and Unassign.

The Pi panel updates itself while it's open (every 10 seconds, every 3 for two minutes after an action), so results
and new screenshots appear without reopening it. If a Pi's check-in was refused, the panel says why and what to do:
a different key (a new card: **Reset device key**), trying to enroll (**Open enrollment**), or switched off. The
agent takes its first automatic screenshot about 2 minutes after it starts, once the directory is up. The console
refreshes once a minute only while its browser tab is on screen.

**Health tab:** every Pi on one page, with problems sorted to the top. It shows:

- uptime today, over 7 days and over 30 days
- power dips, current and peak temperature, and browser outages
- IP address, agent version, and last check-in

It filters by account and exports a CSV, for customer service reports.

Uptime comes from a daily summary for each Pi (`device_daily`), kept for 400 days. Each check-in credits the time since the Pi's previous one, if that was 3 minutes ago or less (`supabase/07-uptime.sql`), so small timing differences never show as downtime. A longer gap is an outage and earns nothing, so an outage reads up to a minute longer than it was, never shorter. A new Pi's uptime counts from its first check-in, so it isn't penalized for time before it was installed. A reboot (about a minute) counts as up.

Only those fixed actions exist; the console can't send anything free-form. Update agent and Update Pi install code downloaded from this site over HTTPS, so whoever can change the site (its GitHub repo and Netlify) is trusted with every Pi: keep those accounts on two-factor sign-in. Actions not picked up within an hour are dropped rather than run late.

**Alerts:** recipients and which alerts each gets (offline, low power, running hot) are set in the console, **Pi setup → Alert emails**, which also has **Send test email** (it shows the mail server's answer). The mail server's sign-in stays in Netlify. Every 10 minutes the site checks each Pi. It sends one email when a Pi goes offline, reports under-voltage, or runs at 80°C or hotter, and another when that clears. A Pi's alert state is saved only after the email has gone out, so a failed send is retried on the next run, and problems that already exist are emailed once when the email settings are first added.

**Enrollment:** each Pi has its own key, stored hashed. A registered Pi with no key yet (from the Yodeck report, or after **Reset device key**) accepts its first key only while its enrollment window is open (24 hours, opened from **Pi** in the console). Anyone who knows a Pi's serial can't claim it outside that window.

**New card in an enrolled Pi?** The agent makes a new key, which the site refuses ("key doesn't match") until you use **Reset device key** in the console. That clears the key and opens the enrollment window for 24 hours; the Pi re-enrolls on its next check-in. Each Pi's key is kept on its card in `/var/lib/lobby-agent/identity.json`, with the serial it belongs to.

## Tests

```
npm install
npm test                      # server functions, against a fake Supabase
node tests/test-server.mjs          # the whole site locally, with sample logins
bash tests/kiosk-rotation-test.sh    # the kiosk: address from the serial, rotation and its watcher, a card moved between Pis, field Wi-Fi setup (about 5 minutes)
python3 tests/agent-test.py          # the Pi's agent: schedule, results, reboot, updates, keys, Update Pi, Wi-Fi search and join, the status light (about 2 minutes)
python3 tests/button-test.py         # the case button and status light, with key presses through a pipe (about 20 seconds)
bash tests/setup-test.sh             # setup's options, Wi-Fi import, naming, TV keeper, pointer, HDMI, quiet start, field Wi-Fi setup (seconds)
```

Local sample logins: `scot@1pointusa.com / admin-pass`, `leighann@barber.test / owner-pass`, `editor@barber.test / editor-pass`.

## Files

```
public/             screen (index.html, display.*), sign-in, console (+ console-devices.js, console-setup.js), editor, technician page (tech.*), shared auth.js
netlify/functions/  screen, users, config, weather, news, agent, devices, networks, alert-settings, alerts
netlify/lib/        Supabase client, RSS reader, shared helpers
supabase/           database schema (01 to 15, run in order), starting data, check queries, setup guide
migration/          the Yodeck/Wix transcription the starting data was built from
public/pi/          setup-kiosk.sh and agent.py (served by the site so Pis can download them)
tests/              function tests, fake Supabase, local test server
```
