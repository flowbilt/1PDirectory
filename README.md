# Lobby Directory

Tenant directory for lobby screens. Replaces Yodeck and the Wix pages. Hosted on Netlify; each screen is a Raspberry Pi 4 running Chromium full screen.

First building: **The Landmark Center** (`landmark-center`), 55" screen in portrait.

- Screen address: `https://YOUR-SITE.netlify.app/?site=landmark-center`
- Editor: `https://YOUR-SITE.netlify.app/admin.html`

## What's on the screen

Property name, clock and date, a small weather reading, the tenant list (name, suite, optional arrow), rotating news headlines with photos, Managed By and Leased By contacts, and a welcome line.

The tenant list sizes itself. With few tenants the type is large. As the list grows it shrinks the type, then drops the news panel to make room, then switches to two columns. Tested up to 45 tenants on a portrait screen.

## Deploy to Netlify (one time)

Drag-and-drop deploys don't work for this project because the server functions need a package installed. Use Git (recommended) or the Netlify CLI.

**With GitHub**

1. Create a private GitHub repo and upload the contents of this folder (not the folder itself).
2. In Netlify: Add new site → Import an existing project → pick the repo. Netlify reads `netlify.toml`; leave the build settings as they are.
3. Before the first deploy finishes, go to Site configuration → Environment variables and add the variables below. Then Deploys → Trigger deploy.

**With the Netlify CLI**

```
npm install
npx netlify login
npx netlify init        # create the site
npx netlify env:set ADMIN_PASSWORD "choose-a-strong-password"
npx netlify env:set NWS_CONTACT "you@1pointusa.com"
npx netlify deploy --prod
```

### Environment variables

| Name | Required | Purpose |
|---|---|---|
| `ADMIN_PASSWORD` | Yes | Password for the editor. Changing it signs everyone out. |
| `NWS_CONTACT` | Yes | An email address. The National Weather Service asks every app to identify itself. |
| `NEWS_FEEDS` | No | Comma-separated RSS feed addresses. Defaults to BBC US & Canada and NPR. |
| `NEWS_BLOCKLIST` | No | Comma-separated whole words. Headlines containing any of them are skipped. Replaces the built-in list (killed, shooting, murder and similar). |
| `DEFAULT_SITE` | No | Building shown when the screen address has no `?site=`. Defaults to `landmark-center`. |

Tenant data is stored in Netlify Blobs, which is built into every Netlify site. There's no database to set up.

### Check the deploy

Open `/api/directory?site=landmark-center`, `/api/weather?lat=33.5186&lon=-86.8104` and `/api/news` on your site. Each should return data, not an error. Then open the screen address in a browser.

## Set up a Raspberry Pi 4

You need Raspberry Pi OS **with desktop**, 64-bit (Bookworm or newer), flashed with Raspberry Pi Imager. In Imager's settings, set the username, Wi-Fi if needed (wired Ethernet is better) and turn on SSH.

1. Boot the Pi connected to the screen. Copy `pi/setup-kiosk.sh` onto it, or download it from your repo.
2. Run it:
   ```
   sudo bash setup-kiosk.sh --url "https://YOUR-SITE.netlify.app/?site=landmark-center"
   ```
3. `sudo reboot`. The directory comes up full screen in portrait.

Options: `--rotate 270` if the picture is upside down (default is 90), `--reboot 03:30` or `--reboot off` for the nightly restart, `--tz America/New_York` for another time zone, `--connect` to install Raspberry Pi Connect for remote screen viewing.

What the script does: desktop auto-login, screen blanking off, SSH on, time zone set, output forced to 1080p (a Pi 4 is slow at 4K and the layout scales so it looks the same), Chromium in kiosk mode that restarts itself if it closes, and a nightly reboot.

If the screen can't rotate on its own, add `&rotate=90` to the screen address in `~/kiosk/kiosk.conf` and run setup with `--rotate 0`. The page will rotate itself instead.

## Everyday use

**Change tenants:** open the editor, sign in, edit the list, and click Publish to screens. The preview on the right updates as you type. Screens pick up changes within a minute.

**Add a building:** click Add building, enter the property name, and use the screen address it shows when setting up that building's Pi.

**Is the screen online?** The editor's top bar shows when the selected building's screen last checked in. It checks in every 5 minutes, so more than 15 minutes means look into it.

**If the internet drops:** the screen keeps showing the last directory it received, including after a reboot, with a small "Reconnecting" note in the corner. Weather hides itself after 3 hours without an update.

**Weather location:** set the building's latitude and longitude in the editor. In Google Maps, right-click the building; the numbers at the top of the menu are its coordinates.

## Tests

```
npm install
npm test
```

Runs the server functions against an in-memory store and sample feeds. No Netlify account or internet needed.

## Files

```
public/            screen (index.html, display.*), editor (admin.*), offline support (sw.js), fonts
netlify/functions/ directory, sites, heartbeat, weather, news
netlify/lib/       shared code, starting data for The Landmark Center, RSS reader
pi/                setup-kiosk.sh
tests/             npm test, plus a local test server
```

Fonts are Instrument Sans and Lora under the SIL Open Font License (licence files in `public/fonts`). They're served from the site itself, so screens don't depend on Google Fonts.
