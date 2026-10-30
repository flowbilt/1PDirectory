# Lobby Directory

Tenant directories for lobby screens, replacing Yodeck and Wix. Hosted on Netlify, with accounts and data in Supabase. Each screen is a Raspberry Pi 4 running Chromium full screen.

## Pages

| Address | Who | What |
|---|---|---|
| `/login.html` | everyone | Sign in, forgotten password, and setting a password from an invitation or reset email |
| `/console.html` | signed in | Screens (status, search, orientation, what each shows), Buildings, People, **Menus** (DP-12: 1Point, and an account once a menu is theirs), and (1Point only) Health, Pi setup, **Layouts** (DP-11) and Accounts |
| `/menu-edit.html?m=…` | signed in | **The menu editor** (DP-12, round E2a): the customer's lists on their boards (see Menus). 1Point always; the account's admins and editors while customer editing is on |
| `/tech.html` | 1Point | The technician page, sized for a phone: Identify, Reload screen, Reboot Pi, Orientation (called Layout before DP-11), and Wi-Fi search and join. Add it to the phone's home screen |
| `/edit.html?d=…` | signed in | Edit one directory's tenants, plus its building's shared settings (address, logo, an owner or manager logo, background photo, contacts), with a live preview. **Sizes** (per screen; `&s=` picks the screen, as the console's Edit tenants link does): title, top logo, bottom logo and Bottom line, each 50–250% of standard within limits (`supabase/18-sizes.sql`); and since DP-08 round 10 the clock and date, weather, news and contacts, each 70–150% (`supabase/22-widget-sizes.sql`; a larger news panel grows with its text and still steps aside when the tenants need the room). Only the sliders for parts the screen shows appear. **Since DP-08 round 11:** per directory, **Show traffic map**, **Show drive times** and **Show nearby places** (all off until ticked), and per building the drive time destinations (up to 3) and nearby places (up to 20: name, distance or walking time, a short line); see The information panel. Standard is unchanged; anyone who can see the screen can change them; the screen picks them up within a minute of publishing |
| `/d/<code>` (and `waytugo.com/d/<code>`) | anyone | **Directory to Go** (DP-08 round 12): the phone page a screen's QR code opens. Read-only: the building, address (with Open in Maps), tenants and suites (a search box for longer directories), contacts (tap to call) and the place lists when the directory shows them; the WayTuGo mark at the bottom. Only for directories with Directory to Go switched on; every open is counted per directory per day (no personal data). waytugo.com forwards `/d/*` here (see The information panel and Directory to Go) |
| `/?device=<serial>` | lobby screens | What a Pi shows: whichever screen the console assigns it to. A screen that shows a **layout** (DP-11) moves itself to `/board.html` with the same options, and back to `/` when it shows a directory again, so a Pi's address never changes |
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
| `NEWS_FEEDS`, `NEWS_BLOCKLIST` | No | Optional news settings. `NEWS_FEEDS`: comma-separated feed addresses. `NEWS_BLOCKLIST`: comma-separated words **added to** the built-in list (in `netlify/functions/news.mjs`). A word also blocks its usual forms ("murder" → murders, murderer, murdered; "body" → bodies) but not other words that start the same way ("dead" doesn't block "deadline"); end a word with `*` to block every word starting with it (`terror*`); several words match as a phrase (`mass shooting`). Headline and description are both checked. |
| `SETTINGS_KEY` | **Yes** | Any long random text (24+ characters). Encrypts the mail server password saved in the console (**Pi setup → Alert emails → Mail server settings**; `supabase/19-mail.sql`). Set once and keep it: changing it makes the saved password unreadable (the console then asks for it again) |
| `SMTP_HOST` | No | Company mail server for alert emails, e.g. `secure.emailsrvr.com` (Rackspace). **Fallback only** once a mail server is saved in the console, which wins |
| `SMTP_PORT` | No | `465` (encrypted from the start) or `587` (STARTTLS). Plain, unencrypted mail servers are refused |
| `SMTP_USER` | No | The mailbox alerts are sent from, e.g. `directory@1pointusa.com` |
| `SMTP_PASS` | **Yes** | That mailbox's password |
| `ALERT_EMAIL_TO` | No | Who gets alerts until recipients are added in the console (**Pi setup → Alert emails**), comma-separated |
| `ALERT_EMAIL_FROM` | No | Sender, e.g. `Lobby Directory <directory@1pointusa.com>`: the same mailbox as `SMTP_USER` (mail servers refuse other senders) |
| `RESEND_API_KEY` | **Yes** | Optional instead of the SMTP settings: Resend, used only when `SMTP_HOST` isn't set |
| `GOOGLE_MAPS_KEY` | No (public by design) | The traffic map's Google Maps **browser** key. It's sent to screens, so in Google Cloud it must be restricted to **Websites** `https://1pdirectory.netlify.app/*` and to the **Maps JavaScript API** only. Without it, the map stays off |
| `TOGO_BASE` | No | Optional: the start of the Directory to Go link in the QR codes. Default `https://waytugo.com/d/`; set it to `https://1pdirectory.netlify.app/d/` only if waytugo.com isn't forwarding yet |
| `MENU_BASE` | No | Optional (DP-11 E1c): the start of the Take this menu with you link in a layout's QR code. Default `https://waytugo.com/m/`; set it to `https://1pdirectory.netlify.app/m/` only if waytugo.com isn't forwarding `/m/*` yet |
| `GOOGLE_ROUTES_KEY` | **Yes**, Functions only | The drive times' Google **server** key, restricted to the **Routes API** only. Never sent to a screen or the browser. Without it, drive times stay off |

Without a way to send, alerts are only logged. Settings take effect at the next deploy (Deploys → Trigger deploy).

`ADMIN_PASSWORD` is no longer used and can be deleted once everyone signs in with their own login.

## The information panel (DP-08 round 11)

The news box is shared: news headlines, a **live traffic map**, **drive times** and **nearby places** take turns in it, so
the tenant list keeps its room (when there's news, every third turn is one of the others). Each is switched on per
directory in the editor and is off until ticked. Its text size is the editor's **News and information** slider.

- **Traffic map:** Google Maps with its traffic layer, centred on the building's weather location (so set that first),
  with a pin on the building, no controls, and the Google logo. It's loaded once per page (Google bills per map load:
  about 10,000 free a month) and kept; the traffic colours refresh themselves. If Google refuses the key, the map simply
  leaves the rotation.
- **Drive times:** live, traffic-aware minutes to the building's destinations (e.g. Birmingham Airport, BJCC), with
  "+N min for traffic" when it's 3 minutes or more over the usual time, and "Google Maps · updated 3:30 PM". Google's
  terms allow no shared copy, so **each screen asks for itself** through `/api/traffic`: every 30 minutes, weekdays from
  6 a.m. to 7 p.m. building time, never more than once in 25 minutes per screen (`traffic_claim` in
  `supabase/23-info-panel.sql`). Only real screens ask: the console's View and the editor's preview show the
  destinations with a dash. Nothing Google returns is stored, on the server or on the screen. Live traffic is Google's
  "Pro" routing tier: 5,000 free a month, then $10 per 1,000; three screens with two destinations come to about 3,500 a
  month. Set daily caps in Google Cloud as the backstop.
- **Places and promotions** (round 12): up to five lists per building, each with its own heading ("Nearby", "While you're here!", "For family fun!"), up to 12 entries each (name, distance or walk time, a short line, and an optional picture or logo, made small in the editor: at most 320 px, under about 100 KB, 12 pictures per building). Each list takes its turn; an empty list never shows. Four entries to a slide, three when the list has pictures. Round 11's places became the first list, "Nearby".
- **Offline:** the map and drive times drop out while a screen is reconnecting; news and places carry on.
- The display page tells Google its origin (`<meta name="referrer">` in `index.html`; the site otherwise sends
  `Referrer-Policy: same-origin`), so a key restricted to the site's address works.
- **Checking a customer's screen (DP-09 round 15c):** the console's View never asks Google, so it shows the drive
  times as dashes. The Pi panel's **Drive times** line says what the real screen reported at its last check-in:
  showing for how many destinations and when Google answered, or why not (hours, waiting its turn, switched off, no
  destinations, no key, Google's error). Never the minutes themselves (Google's terms forbid keeping them): for
  those, **Take screenshot** while they're up.

## Directory to Go and the WayTuGo mark (DP-08 round 12)

- **Powered by WayTuGo · waytugo.com:** a small, quiet line at the very bottom of every screen, below the bottom logo.
  1Point can hide it per screen (console, **Screen settings → Hide "Powered by WayTuGo"**) for a customer who pays not
  to have it. It steps aside while "Reconnecting…" shows.
- **Directory to Go:** a QR code at the end of the contacts band with "Take this directory with you!" (the customer can
  change the words), switched on per directory in the editor (off by default), with its own size slider (70–150%).
  The screen draws the code itself (`public/vendor/qrcode.js`: Kazuhiko Arase's MIT-licensed encoder, bundled; no
  outside service). It opens `waytugo.com/d/<code>`: each directory has its own 6-character code (no 0/O/1/I/L), shown
  in the editor with the scan count (last 30 days, and in all); **Replace the code** makes a new one at once and the old
  link stops working.
- **waytugo.com forwards `/d/*` here** with one rewrite on the waytugo.com Netlify site, so visitors stay on
  waytugo.com: in that site's `_redirects` file, `/d/*  https://1pdirectory.netlify.app/d/:splat  200!` (or the same
  as a `[[redirects]]` rule in its `netlify.toml`).

## People under tenants (DP-09 round 14)

- **Found only through their company:** in the editor, each tenant's **People** button opens the list of people at that
  company. On a touch screen (round 15) a visitor taps the company to see them; there's no building-wide list or search
  of names, by design (someone looking for a person should know the company).
- **Per building, not per screen:** the database keeps one company per name per building (`companies`, made and linked
  from the tenant rows; case and spaces don't matter), so every screen in the building that lists a company shares
  its people. Fixing a typo in a tenant's name keeps its people. Removing a tenant from a directory keeps the company
  and its people for the building.
- **An entry holds** first and last name, title, phone or extension, email, and a suite when it differs from the
  company's. The customer fills in as much as they want: a person is kept whether or not they show (later work, such
  as telling a person a visitor is here, will need the record).
- **The owner decides what shows:** per company, **Show … people on touch screens** (off until the owner turns it on)
  and which details show (title on; phone and email off by default); per person, a **Show** tick. The owner's admins
  and editors edit them, and so can 1Point (for a customer who pays for full management); 1Point sets no default.
- **Never anywhere else:** people go only to screens marked touch, only with the switch on, only those ticked Show, and
  only the details shown. Display-only screens and the Directory to Go phone page never get them
  (`supabase/26-people.sql`).

## The touch directory (DP-09 round 15)

Only on screens marked **This is a touch screen** (console, Screen settings). Display-only screens are exactly as before.

- **Tap a company** for its card: name, note, suite (and arrow), and its people when the owner has switched them on
  (People under tenants, above), with only the details the owner shows; a person's own suite shows when it differs.
  **Back to the directory** is at the bottom of the card, in reach; a tap outside the card closes it too.
- **Sized for a finger:** from **Screen size (inches)** (32" when blank), names are never smaller than a fingertip's
  row (about 15 mm), and buttons are about that tall.
- **A to Z, only when needed:** when the list can't fit at a finger's size, it scrolls (drag it with a finger), and a
  strip of the letters in use sits under it; tapping one brings that letter's first company to the top.
- **Dragging works however the panel reaches the browser (round 16):** some touch panels arrive as a mouse, and a mouse
  drag doesn't scroll a list, so the display scrolls the list itself when it's dragged (the directory, a card's people
  and the keyboard's matches), with a short glide after a flick. A drag of more than about 2 mm isn't a tap; a small
  wobble still is. Real touch input scrolls the browser's own way.
- **The accessible keyboard, when the customer chooses:** the editor's **Show the accessible keyboard on touch
  screens** (per directory, off by default) adds a **Search** button at the bottom left of the directory. It opens an
  on-screen keyboard in the lower part of the screen that finds **companies by name only** (never people: they're
  found only through their company); tap a result for its card. Since round 16 (display 2.14.0): keys about 12 mm
  (0.8 of a fingertip, between 4 and 7 units) in a compact block; the matches sit above the keys and always keep room
  for at least three, updating with each key; **Show** puts the keys away so the matches have the whole panel (with
  exactly one match it opens that company's card); tapping the field or **Keyboard** brings the keys back.
- **Back to the directory by itself:** after **Back to the directory after (seconds)** with no touch (Screen settings,
  15 to 300, 45 standard), an open card or keyboard closes and the list goes back to the top. A directory change
  published while a visitor is using the screen waits until they're done.
- **Places and promotions (DP-10 round 18, display 2.15.0; 18b, 2.15.1):** on a touch screen whose directory shows places
  (the editor's Show places and promotions), a **Places and Events** button sits beside Search; it opens every list, a tab per
  heading, each place with its picture, name, distance and line. A place on the information panel's slide can be
  tapped too, and the panel holds that slide while its card is open. A place's card shows the picture larger, the
  name, distance and line, and, when the editor gives the place an **Address or web link**, a QR code with the place's own line beside it (the editor's **Line beside the QR**, e.g. "Get tickets"; blank
  says "Take it with you: scan with your phone's camera"): a web address as it is, a bare domain (`barbermotorsports.com`) as https, anything else as an address in
  Google Maps. **Back to the list** or **Back to the directory**; the idle time closes everything. The Directory to Go
  phone page makes a place with a link tappable too. Display-only screens are unchanged.
- **Trying it without a touch screen:** the console's **View** shows a pointer on touch screens, and a mouse click
  works as a tap.
- `supabase/28-touch-directory.sql`: `screens.touch_idle_s`, `directories.touch_keyboard`, and `screen_state` sending
  the idle time.

## Layouts (DP-11, round E1a)

A screen can show a **layout** instead of a directory: a grid, a theme and blocks, kept as data (never code), the
start of the display templates in `expansion-brief.md` (menus, schedules, boards). The directory is untouched: a
directory screen is drawn exactly as before (the browser checks compare it element by element with the previous display).

**In the console (1Point only in E1a):** the **Layouts** tab lists layouts. **Add layout** (account, name, kind,
orientation), then paste the layout's JSON and:
- **Check**: problems (it can't be published until they're fixed) and warnings (the guardrails: text too small for the
  screen size and viewing distance, low contrast, blocks overlapping); keeps it as the draft.
- **Preview** in one of the account's buildings: drawn exactly as a screen draws it now (its schedules follow that
  building's clock); a block whose text doesn't fit even at the smallest size allowed is marked in red and becomes a warning.
- **Publish** (with an optional note): a new version. With warnings it asks first; **Publish anyway** is recorded with
  the version. Every version is kept and never changed; **Roll back to this** publishes an earlier one again as the
  newest. Screens showing the layout change within a minute.
- Then point a screen at it in **Screen settings → Shows** (layouts are listed by account) and choose the **Building**
  it's in (the layout takes its time zone, weather and address from it). A layout's orientation is fixed: a portrait
  layout goes only on a screen whose Orientation is Portrait (or Portrait turned the other way), and the console says so
  in plain words if not. To go back, choose the screen's directory again in Shows.

A layout belongs to the **account**, not a building, so later one layout can show at many sites (every block has an
`id` that never changes, which leaves room for per-site overrides). Owners see their account's layouts and layout
screens; customers' content editing comes with E2.

**Pictures (round E1b).** Below a layout's JSON, **Pictures** lists the account's pictures. **Upload pictures** takes
one or many JPEG, PNG or WebP files; the console shrinks each in the browser first (longest side at most 1,920 pixels,
WebP, under 900 KB; a logo keeps its transparency), then the site checks what the file really is from its own bytes and
stores it. Each picture gets a **key** from its file name (`Maple Bacon.jpg` → `img:maple-bacon`), unique in the account
(a second Maple Bacon becomes `img:maple-bacon-2`) and fixed once made, so a layout can be written before its pictures
are uploaded. **Copy key**, **Rename** (the name only; the key stays) and **Remove**. Rules:
- A picture's file is never changed or overwritten: uploading again makes a new file with a new key. So every address
  is permanent and cached for a year, and each screen fetches a picture once and keeps it in its offline copy.
- A picture can't be removed while any layout of the account uses it, in its draft or any kept version (Roll back
  needs it); the console says which layout.
- Check, Preview and Publish treat a key the account doesn't have as a problem ("There's no picture …").
- Pictures live in Supabase Storage (the public `layout-images` bucket, at most 1 MB each, `supabase/30-layout-images.sql`)
  and are served through this site at `/img/…` (a rewrite in `netlify.toml`), so screens only ever see the site's
  address. The bucket's address in `netlify.toml` is the project's public URL; no key is involved.
- Only 1Point uploads, renames and removes pictures for now; owners see their account's.

**Take this menu with you (round E1c).** Every layout has a menu code (six letters and digits, like Directory to Go's),
made when the layout is added. A `qr` block puts the code on the board; it opens **`waytugo.com/m/<code>`** on a phone
(waytugo.com forwards `/m/*` here, as it does `/d/*`; `MENU_BASE` can point the codes elsewhere). The console shows the
address under the layout's name, with how often it's been opened in the last 30 days and in all.
- The phone page shows the layout's **published version as designed**: its colours, fonts, logo and pictures, laid out
  to scroll down a phone in reading order (each column of the board top to bottom), with only the blocks on now by the
  building's clock (the fall box shows on the phone only while it's on the board). No clock, weather or QR code.
  A rotator becomes a strip of pictures to swipe.
- Items, text, photos and a rotator's pictures can carry a `link` (a full web address); on the phone they're marked
  and open in a new tab. The board itself shows no links.
- **See the board** opens the board itself, scaled to the phone (pinch to zoom), for showing a prospect what they'd get.
- The building: the one of the most recently seen screen showing the layout, else the account's first by name.
- Each open is counted per layout per day; nothing about the visitor is kept. Not indexed by search engines.

**The format** (`public/layout-format.mjs` checks it; the site, the console and the screen all use that one file):

```json
{ "format": 1, "orientation": "portrait",
  "grid": { "cols": 12, "rows": 24, "gap": 16, "margin": 40 },
  "viewing": { "inches": 43, "metres": 3 },
  "theme": { "palette": { "bg": "#fff7ec", "ink": "#2b1a12", "accent": "#c0392b", "onAccent": "#ffffff" },
             "fonts": { "display": "Fraunces", "body": "Instrument Sans" } },
  "blocks": [ { "id": "hero", "type": "photo", "at": { "col": 1, "row": 4, "w": 12, "h": 7 }, "layer": 0,
                "style": { "surface": "panel", "radius": "l", "size": "xl" },
                "content": { "caption": "Maple Bacon", "price": "$1.89" },
                "when": { "days": [2, 3, 4, 5, 6], "from": "06:00", "to": "11:00", "dates": { "to": "2026-11-30" } } } ] }
```

- **Canvas:** 1080 × 1920 (portrait) or 1920 × 1080 (landscape) whatever the screen; the screen scales it to fit and
  turns it to its Orientation. `gap` and `margin` are canvas pixels; the bottom margin is never less than 36, where
  "Powered by WayTuGo" sits (only 1Point's per-screen switch hides it).
- **Grid:** 4–24 columns, 4–48 rows; each block's `at` is whole cells (`col` and `row` from 1). Blocks on the same
  `layer` (0–9) shouldn't overlap (a warning) unless their schedules never show them together; a higher layer sits on top.
- **Palette** names: `bg ink muted accent onAccent panel onPanel highlight onHighlight line` (colours as `#rrggbb`).
  A block's `surface` (`none bg accent panel highlight`) picks its background and the matching text colour; `ink` overrides it.
- **Fonts** (stored on the site, from google/fonts, so they work offline): Instrument Sans, Lora, Oswald, Bebas Neue,
  Alfa Slab One, Fraunces, Playfair Display, Pacifico, Crimson Pro; roles `display`, `body`, `accent`.
- **Style:** `surface`, `ink`, `font` (role), `size` (`xs s m l xl xxl huge`: 24 to 120 canvas pixels), `align`, `valign`,
  `radius` (`none s m l round`), `pad` (`none s m l`), `border` (palette name), `tilt` (−8 to 8°), `shadow`, `case` (`upper`).
- **Block types** and their content: `text` (kicker, title, body, note); `items` (heading, a group `price` such as
  "$1.89 each", `columns` 1–3, `leaders`, items with name, line, price and tags `sold-out seasonal new limited favorite`);
  `chips` (heading, items with tags); `price` (a sticker: label, price, note; round by default); `photo` (caption, line,
  price, `image` as `img:<key>`, `fit` `cover` or `contain`, `focus` `center top bottom left right` for which part a cover
  crop keeps; a quiet panel when there's no picture); `rotator` (E1b: up to 12 pictures taking turns, cross-fading every
  `seconds` 4–60, default 8; each with image, alt, caption, line and price; `fit` and `focus` for all); `logo` (`image`,
  else `text`); `clock` (time, date or both);
  `weather` (the building's, as on the directory); `hours` (opening hours by day: "Open now · until 6 PM", "Closed now ·
  opens tomorrow at 6 AM", and the week); `timetable` (columns and rows by day, today highlighted); `nownext` (sessions
  by day and time: what's on now and next).
- **QR block** (E1c): `qr` with an optional `line` under the code (default "Take this menu with you"); it draws the
  layout's own menu code, as large as its box allows less one line of text. **Guardrail:** a code reads from about 10
  times its width, so one under 100 mm across on the screen size given is a warning ("reads from about 0.7 m").
  On a 55" landscape board on the 24-column grid, 3 × 3 cells is enough.
- **Links** (E1c): `link` on items, `text`, `photo` and a rotator's pictures: a web address written in full
  (`https://…`, at most 300 characters); only the phone menu uses it.
- **Lists** (E2a): `list` on `items`, `chips`, `rotator`, `photo`, `text` and `hours` blocks shows a list of the layout's
  menu (see Menus); `chips` can carry a list `price` beside its heading.
- **Background picture** (E1b): `theme.background` `{ "image": "img:…", "dim": 0–90 }` (dimmed by the `bg` colour,
  60% unless said). **Guardrail:** text standing straight on a photo or rotator, or on a background dimmed below 60%,
  is a warning; give the block a `surface` (a band behind the text). Blocks in the same place whose `dates` never meet
  take turns, so they aren't an overlap (a fall box, then the box that follows it).
- **Schedules:** `when` is one schedule or a list (the block shows when any matches): `days` 1 = Monday to 7 = Sunday,
  `from`/`to` 24-hour times in the building's time zone (`to` not included; past midnight works), `dates` from/to
  (both days included). `"on": false` hides a block by hand. The screen re-checks every second, so a block appears or
  goes on the minute.
- **Text fits itself:** each block's text shrinks to fit its box, down to 55% of its size; past that it overflows
  (the preview marks it and Publish warns).
- The first layout, **Donut Joe's Pelham** (an internal spec from the DP-06 mockup, not for a public ad), is in
  `layouts/donut-joes-pelham.json`. The second, **Donut Joe's counter board** (55" landscape, with the shop's pictures:
  the logo, a rotating hero, the energy drinks, a fall box that hands over to "Take some home" on December 1), is
  `layouts/donut-joes-counter-55.json`; its menu source is `layouts/donut-joes-menu-source.md`. Internal spec only. Since E1c it carries the QR code ("Scan for
  the menu", where the drinks photo was; the drinks joined the hero) and links on the party box and the Joe to Go
  Carafe (to the shop's home page until it has the exact pages).

## Menus (DP-12, round E2a)

WayTuGo builds each board from the company's own layout; the customer edits only what's on its lists: items,
descriptions, prices, pictures (from the account's pictures; uploading their own comes in E2b), Sold out today, Hide,
the order, a price over a whole list, the hours, the announcement and the bottom line. Scot's decisions (2026-10-28):
what they enter fills the board automatically and stays lined up; **changes go live at once, with no approval step**;
lists are **overbuilt** (room for about 40 when the menu has 30; only filled entries show; past the room is a paid
**menu expansion**); 1Point can always edit, the customer is the secondary editor; **one set of lists** feeds the
counter board, the 32" chalkboard and outdoor stand, and the phone menu. List headings stay with 1Point (the customer
asks the company to change one). Desktop first; the phone version of the editor is a round of its own.

- **A menu** (`supabase/32-menus.sql`, `public/menu-format.mjs`) belongs to an account and feeds every layout that names
  it. 1Point sets its lists up (the *spec*): each list's `key`, `name` (what the customer sees), `kind` (`items`, `text`
  with room for 1, or `hours`), `room`, `fields` (the boxes the customer fills: `name line price image tags link`, or
  `title body link`), `caps` (the most characters per box, so a name can't outgrow its line), `groupPrice` (one price
  over the list, like "$1.89 each"), `note` (a line under the hours), `hint`. The customer's entries are the *content*.
- **A layout's block shows a list** with `"list": "<key>"` on an `items`, `chips`, `rotator`, `photo`, `text` or `hours`
  block (chips can carry a list price too). Its heading, size, colours and place stay in the layout; the content the
  list gives (items, the list price, a photo's picture and caption, a text's title and body, the hours) can't also be
  written in the layout. Check and Publish check every list against the layout's menu.
- **Stays lined up:** an items or chips block keeps its list's full room on the board (invisible rows), so the text is
  the size the board was designed at, however much is filled in, and adding an item never shrinks the others. The
  guardrail judges a list block by what its list may hold (a tag can be added any day). The phone menu shows only
  what's there. **Show the empty room** (in the Layouts preview and the menu editor) draws the room dashed.
- **Only what's shown:** hidden entries stay in the editor and never leave the site; an item sold out today is struck
  through with "Sold out" on the boards and the phone, and clears itself at the building's midnight; a featured
  picture that's sold out steps out of the turns; a list with nothing showing leaves its box out.
- **Saving** (`menu_save`, called as the signed-in user, so the database decides who may): 1Point always; the account's
  admins and editors while the menu's **customer editing** is on (off for a full maintenance plan: the editor is then
  read-only, "1Point keeps this menu up to date for you"). The database refuses past the room ("has room for 16; this
  has 17. More room is a menu expansion: ask 1Point."), over a box's cap, a box the list doesn't have, a picture from
  another account, and a save over someone else's newer one ("Someone else saved this menu after you opened it
  (Front Desk, …). Reload…"). Before saving, the editor draws **every board on the menu** with the changes and refuses a
  save that would make a list run out of its box, saying which (1Point may **Save anyway**). Saved changes reach the
  screens within a minute (the screen's answer carries the menu's revision).
- **History:** every save is kept, whole, with who made it and whether it was 1Point (the terms' errors-and-omissions
  line); the editor lists what changed in plain lines ("Coffee bar · Cold Brew: price $4.29 → $4.49") and **Restore**
  puts an earlier save back as a new one. A picture a menu uses can't be removed (E2c: only while it's on the boards now).
- **Making a menu (1Point):** on a layout's page in the Layouts tab, **Make lists from this layout** checks the JSON,
  then offers each items, chips, pictures, text and hours block as a list, with a name and a room (about a third more
  than it holds now) to change; it makes the menu from what the blocks say, points the blocks at the lists and keeps
  the draft; Preview and Publish put the board on them. A lone photo stays the layout's unless ticked. Or **use** a
  menu the account already has (the chalkboard on the counter board's lists). **List settings** edits the spec as JSON
  (a list a published layout shows can't be taken off; a room can't go below what's in it); **The customer edits it
  too** switches customer editing.
- **The Donut Joe's counter board's rooms** (`layouts/donut-joes-counter-55.json`, measured on the board): featured
  pictures 7, hours 2, donuts 16, pastries 7, coffee 8, Jammin' Joe's 5, fall 4, take some home 4 (40 items of room for
  the 34 there now). The room costs some text size on this board: donuts 66% → 60%, pastries 73% → 64%, the fall box
  63% → 59% of their set sizes (worth seeing on a real 55").

### E2b (DP-12): specials with dates and times, showWhen, the WayTuGo name

- **Customers see WayTuGo** (Scot, 2026-10-29): every line a customer can see says WayTuGo, made by 1PointUSA
  ("WayTuGo keeps this menu up to date for you. Contact WayTuGo for changes.", "More room is a menu expansion: ask
  WayTuGo.", saves by 1Point's staff marked "(WayTuGo)" in History). 1Point's own screens (Layouts, List settings, Save
  anyway) keep "1Point". The database's customer-facing messages follow (`supabase/33-menu-specials.sql`).
- **Specials with dates and times:** a list set up with `"schedule": true` (items or text; in List settings) gives each
  entry a **When** in the menu editor: first and last day, days, from and to times (all optional; no days is every day,
  no times all day; past midnight works). The editor says *On now*, *Starts Nov 1*, *Ended Oct 31* or *Not on right
  now*. Boards and the phone menu show an entry only while its When says so, switching by the building's clock with no
  save. An entry waiting for its dates uses up room like any other.
- **A box that follows a list:** a block's `"showWhen": { "list": "fall", "is": "empty" }` (or `"showing"`) shows it only
  while that list has nothing on (or something on). The overlap guardrail knows such boxes take turns. The Donut Joe's
  counter board on its lists is `layouts/donut-joes-counter-55-lists.json`: the fall box and its picture while the fall
  list has a special on, Take some home and its picture whenever it doesn't.
- **Preview full size:** opens the board with the unsaved changes in its own window (full screen if wanted), following
  the changes as they're typed. Nothing reaches a screen.
- **Fit while typing:** every board on the menu is drawn out of sight and checked after each change; a list that would
  run out of its box is outlined in red with "Doesn't fit on Counter board: shorten what's written here, or hide an
  item." Save still refuses it (1Point may save anyway).
- **Add lists from this layout (1Point):** on a layout that already shows a menu, the blocks not yet on lists become
  more lists on that menu (kept as a new save by 1Point); a key the menu already has gets `-2`. So a second board (the
  chalkboard) can **Use this menu**, then add its own lists beside the shared ones.

### After E2b (DP-12): List settings as a form, and the character count

- **List settings is a form** (Scot: menu edits never need code; layouts may stay scripted): on a layout's Menu box,
  one card per list with the name the customer sees, its room (not below what's on it now), the boxes the customer
  fills as ticks, each text box with its **most** characters (live only while ticked), **Price over the whole list**,
  **Line under the hours**, **Dates and times on each entry**, and a hint. Saving checks the rules and that what's on
  the lists now still fits them ("…doesn't fit these settings: "Coffee bar", item 1: This list has no price box…"); the
  database checks again. The JSON is still there under **Advanced** (used instead of the form when changed), for what
  the form doesn't do, such as taking a list off.
- **The character count:** near a box's limit (80%) the menu editor shows "22 of 25" by the box; at the limit, "25 of
  25 · the most this box holds on the board", so a customer knows why typing stopped.

### E2c (DP-12): customers' own pictures, and sold out taking no room

- **Your pictures** (menu editor): an account's Account Admins and Editors upload their own pictures (shrunk in the
  browser to WebP, longest side 1,920, under 900 KB; the site reads each file's own bytes, as for 1Point), rename them,
  and remove ones not on the boards. Each says *On the boards now*, *Part of the board's design (WayTuGo's)*, *In your
  unsaved changes* or *Not on the boards*. Only while customer editing is on for one of the account's menus; 1Point
  always (`/api/pictures`, `netlify/lib/pictures.mjs`; shared shrink in `public/picture-shrink.mjs`).
- **Choosing an item's picture:** **Choose…** / **Change** on the row opens a picker with thumbnails, a find-by-name
  box, **Upload a new picture** (chosen at once) and **No picture**.
- **Room for pictures:** 100 per account to start ("12 of 100"); 1Point changes it per account in **Accounts → Edit**
  (a picture expansion). The database refuses the one past it: "This account has 100 pictures, the most it holds.
  Remove ones you no longer use, or ask WayTuGo for more room." (`supabase/34-customer-pictures.sql`).
- **Removing** (Scot: verify the pictures are removed from Supabase as well): refused while the picture is on the
  boards now (a menu's lists, or any layout's draft or kept version); otherwise the site deletes the file from Storage,
  **asks Storage again** that it's gone, and only then removes the picture's row. If Storage still has it, nothing is
  removed and it says so. A picture only an *old* menu save used can go; **Restore** of that save brings its items back
  with no picture and says how many. The same order applies to 1Point's Remove in the Layouts tab.
- **Check storage** (1Point, Accounts → Edit): the account's files in Storage against its pictures: left-over files
  (with no picture; ones uploaded in the last 10 minutes are left alone) can be removed and are checked gone; missing
  files are named, to upload again.
- **Sold out today takes no room** (Scot, 2026-10-29: ticking sold out made the fall list not fit): the *Sold out* mark
  is laid over the end of the row (the struck-through price), never beside the name, so marking an item sold out can't
  change whether a list fits. Display 2.21.0. **2.21.1** (Scot: the first mark was muddy): a small, solid red *Sold out*
  with a thin white edge, the price under it hidden.

### E2d (DP-13): the chalkboard, looks and options

- **One layout, two looks** (`theme.looks: ["house", "chalkboard"]`, the default `theme.look`, and `theme.chalk`
  `{ titles, prices, accents, lettering, frame }`): **House** is the layout's own palette and fonts (the chalkboard
  copies the counter board's); **Chalkboard** is a slate drawn by the screen (no picture), plain text in white chalk,
  chalk colours from six (white, yellow, pink, blue, green, orange; each passes the contrast check on slate) for the
  **titles**, the **prices** and the **accents** (chips, lines, the edges of boxes), **Sign-writer** lettering (Pacifico
  titles, Bebas Neue items) or **Chalk hand** (Caveat Brush, OFL, from google/fonts), a chalk grain over the lettering,
  and an optional **wooden frame**. On the slate a logo shows its `chalkImage` (a light version) if the layout has one,
  else the name in chalk. `layout-format.mjs`: `applyLook`, `boardChoice`, `offersChoice`.
- **Options by tick box** (`"options": [{ "key": "coffee-bar", "label": "Show the coffee bar", "default": false }]`): a
  block says which way it shows, `"showWhen": { "option": "coffee-bar", "is": "on" | "off" }`, so 1Point lays out both
  arrangements (on the chalkboard, Today's specials takes the full width with the coffee bar off, and shares it with
  the coffee bar when on). Blocks for the two states are never counted as overlapping.
- **Who picks:** the customer (while customer editing is on) and WayTuGo, in the menu editor's **Board look** panel, one
  per board whose layout offers choices; the preview follows at once, the fit is checked as for any change, and **Back
  to WayTuGo's design** clears the choice. Saved with the menu as `content.boards[<layout id>]`
  (`supabase/35-board-looks.sql`; only the presets are accepted, in plain words), in History ("Board look (Donut Joe's
  chalkboard): titles chalk (as designed) → green"), kept by Restore and by Add lists from this layout. Screens get it
  as `look` beside `lists`; the phone menu draws in it too. The outdoor stand shows the same layout on its own screen, so
  it always matches.
- **The chalk grain and its speed:** a small speckled tile made once on a canvas and laid over the lettering as a mask
  (chosen over a live SVG filter). Each layout screen measures how long it took to draw and the frame rate over 20
  seconds while its pictures turn, and sends it with the check-in (`X-Board`); the Pi panel shows a **Board** line:
  "Drawn in 1.4 s · pictures change at 60 fps · Chalkboard with the chalk grain · nothing overflowing" (also any block
  whose text doesn't fit: E1's open item, the overflow report). Below 25 frames a second the grain is dropped on that
  screen, and the line says so.
- **Sold out on a name that wraps** (Scot, DP-13): the mark is anchored to the name's last line. Display **2.22.0**.
- **The Donut Joe's chalkboard** (`layouts/donut-joes-chalkboard-32.json`, one file since E2e):
  32" portrait, 12 × 24, on the counter board's menu: featured pictures, **Today's specials** (its own list, room 6),
  the **chalk note** (its own, one line), Fall flavors or Take some home, Jammin' Joe's, the announcement, hours and the
  phone-menu QR; the coffee bar by tick box.

### E2e (DP-13): the layout page in tabs, one file per board, the menu editor's preview

- **The layout page has four tabs** (Scot: the JSON, Add lists and List settings were confusing in one space):
  **Design** (Layout (JSON), Check, Preview, Publish), **Menu** (which menu, a table of its lists with kind, room,
  what's on each and whether this board shows it, List settings, Add lists from this layout, customer editing),
  **Versions** and **Pictures**. The preview stays beside them.
- **One file per board:** on a layout whose Menu tab has a menu, **Check** offers the blocks that still write their
  own items, text or hours as new lists on that menu ("Make these lists", with a room each); until they're made, a
  block of the same file may already show one of them (the chalkboard's specials beside the coffee bar), Preview draws
  them as they will be, and Publish refuses. A block that writes its own items may say `"room": 6` and `"schedule": true`
  (items or text): the list it becomes gets that room (never below what it holds) and dates and times; both are taken
  off the block when it's made a list, and a block on a list can't say them.
- **List settings** refuses a layout pasted under *Advanced: edit as JSON*: "This is a layout, not list settings.
  Cancel, then paste it on the Design tab, in Layout (JSON)."
- **The menu editor's preview** (Scot: a portrait board was cut off at the bottom): the board fits the window's height
  as well as the column's width, the preview column stays in view while the lists scroll, and **Your pictures** and
  **History** are tabs under it, each scrolling on its own. A landscape board still fills the column's width.
- The counter board's Joe to Go Carafe links to its own page on the shop's site (Scot); on the live menu that link is
  the customer's (menu editor → Coffee bar).
- Display **2.22.1** (the layout format's new `room` and `schedule`, so every screen has the same format as the site).

### E2f (DP-13): pasting a board again, the preview column, a building's location

- **Pasting a board's file again** (Scot: the coffee bar came back as a "-2" copy): when a block's list is already on
  the menu, with the same key and kind, Check offers it as **already on the menu: the board shows what's there**, with
  **use it** ticked; Make these lists then points the board at it and adds nothing (the file's sample entries are left
  out, so the customer's own items stay). A list of another kind under that key still gets `-2`.
- **The menu editor's preview column scrolls as one** (Scot: the inner scroll bar was stuck): Your pictures and History
  no longer scroll on their own, so the end of either is reached with the column's one scroll bar.
- **Buildings → Building details** has the **weather location** ("lat, lon") and the **time zone** (Central, Eastern,
  Mountain, Arizona, Pacific), so a building whose screens show only layouts (a restaurant's boards) has them without a
  directory. The board's clock and dates use the building's time zone.

### T0 (DP-13): templates, copying a shop, sample links

Scot's plan (DP-13): one complete example shop per kind of restaurant (coffee shop, Italian, pizzeria, sandwich shop,
sports bar and grill, Mexican) to show prospects; before an appointment, a template is copied and fitted to the shop;
once they sign, the fitted copy goes into their own account. Only 1Point copies or makes samples, never the customer.

- **Account types** (Accounts → Edit → Type): **WayTuGo templates** (the example shops) and **WayTuGo samples** (templates
  fitted to prospects), besides Owner and Owner / manager. They're ordinary accounts, so a template is edited as any menu is.
- **Copy to an account…** (Menus, 1Point only; `netlify/functions/shops.mjs`, `supabase/36-templates.sql` `shop_copy`):
  copies a menu with its lists and items, **every board on it** (published as they are now, each with its own new
  phone-menu code; one never published comes as a draft), each board's look, and **the pictures they use**, as the
  account's own files (a key the account already has gets `-2`, and the copy's lists and boards follow it). Into an
  existing account or a new one made in the same dialog, optionally with a new building (name, address, weather location,
  time zone). Board names default to "<copy's name>: <board's name>". All or nothing: if the database refuses (no room
  for the pictures, say), the copied files and a new account are removed again. The copy shares nothing with the original.
- **Sample links** (a layout's **Sample** tab, 1Point only): `waytugo.com/s/<name>` shows the board's published version to a
  prospect, filling their window, with a **Sample · WayTuGo** mark in the corner; WayTuGo's changes show within a minute;
  its QR code opens the board's phone menu. Each link has a building (its name, address and clock), a length of **30,
  60 or 90 days** from when it's set (changeable; an ended link can be opened again), and **Turn off**, which ends it at
  once. Opens are counted (the page's first load). The name is chosen or random (`demo-` and six letters). Pages:
  `/s/<name>` (a small page framing `board.html?sample=<name>` by full address, so it works on waytugo.com) and
  `/api/sample?code=` (`netlify/functions/sample.mjs`; 404 for no such link, 410 once ended). A board on no screen
  takes its building from its newest open sample link (`menu_page`), so its phone menu names the prospect's shop.
- **waytugo.com forwards `/s/*` here**, as it does `/d/*` and `/m/*`: in that site's `_redirects`,
  `/s/*  https://1pdirectory.netlify.app/s/:splat  200!`.

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
2. **Flash one card** with Raspberry Pi Imager: Raspberry Pi OS (64-bit, with desktop). In Imager's customisation,
   set the user name (`pdirectory`) and the shared password (keep it in the password manager: every card copied from
   this one has it; recent Raspberry Pi OS has no default login), the Wi-Fi country (US) and time zone, and **turn on
   SSH with password login** so no keyboard is needed at the Pi. Leave **Raspberry Pi Connect off** (`--prepare` doesn't
   sign it out, so every copy would carry the account link; Connect is switched on per Pi from the console instead).
   Wi-Fi is only needed if the bench Pi has no cable; the bench's own network is removed from the card at the end.
3. **Boot it in any Pi** (the bench Pi), on a cable, and give it a couple of minutes. From a PC (Windows Terminal,
   PowerShell or WSL): `ssh pdirectory@<the Pi's address>` (the address is in the router; type `yes` the first time).
   Or use the Pi's own Terminal and keyboard. Update the OS (`sudo apt update && sudo apt full-upgrade -y`), then in
   the console, **Pi setup → Get a prepare code**, and run the two commands the console shows:

   ```
   curl -fsSLO https://1pdirectory.netlify.app/pi/setup-kiosk.sh
   sudo bash setup-kiosk.sh --prepare --code ABCD-EFGH
   ```

   It installs everything, saves the Wi-Fi, clears everything that belongs to the bench Pi (machine ID, logs,
   browser data, keys, the bench's own Wi-Fi), switches SSH off and powers off (an SSH session simply drops; that's
   expected). **Don't start that card again before copying it.** Proven 2026-10-14 (DP-07): prepared over SSH with no
   keyboard at the Pi.
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
   **Screens → New devices** (or, for a pre-registered Pi, it shows its screen). In a Pi that's already enrolled (the
   bench Pi, say), the console instead says **"This Pi is checking in with a different key: a new card in an enrolled
   Pi? Use More → Reset device key."** That's expected: Reset device key, and it enrolls at its next check-in (the
   screen works meanwhile). A Yodeck Pi is pre-registered with no key, so on its install day open its enrollment
   window in the console before swapping the card.
8. **Duplicating cards** (the 1-to-3 SD duplicator): the source must be a card **never started in a Pi** (a first
   start personalises a card: machine identity, grown partition, hotspot code), e.g. one freshly written from the
   image. Test one of the copies, not the source.

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
   the network has no internet, choose to stay connected. **Android:** turn off mobile data while setting up, or the
   phone may send the page over mobile data and never reach the Pi. A keyboard at the Pi works too, on the same page.
3. Pick a network (or type a hidden one's name), enter its password, and submit. Not listed yet? **Search again**
   (the page also searches by itself every 15 seconds while it has found nothing). The Pi joins it, confirms it can
   reach the site, and starts the directory normally. A locked network chosen without its password is caught at once.
4. **Since DP-10 round 16b (Update Pi, agent 1.10.0):** the page answers straight away with **Trying <network>…**,
   because the Pi has one radio and its hotspot drops while it tries (for up to a minute). If it works, the screen
   shows its directory and the hotspot goes away. If not, the hotspot comes back and the page (on the phone once it
   rejoins, and on the TV) says **<network> didn't work** and why (wrong password, not in range, or joined but can't
   reach the site), large at the top, **with that network still chosen** and the password box empty. Before 16b the
   phone never got that answer: it rejoined, reloaded and showed the top network chosen again, which looked like the
   choice being lost (seen on the first Wi-Fi retrofit, 2026-10-27). Each try (when, network, worked or not, why;
   never the password) is kept on the Pi (`/var/lib/lobby-agent/wifi-setup.json`, the last five, cleared by
   `--prepare`) and, once the Pi is online, shows in the Pi panel as **Field Wi-Fi setup**. Every try is in the kiosk
   log too.
5. **Since round 16c** (Scot's bench test, 2026-10-27: the waits looked like nothing was happening, and a tech might
   type the password again): the phone's message says a try takes 30 seconds to a minute and **not to press Connect
   again**, and Connect is greyed out ("Trying… please wait") while a try runs; the TV, which keeps the page
   throughout, counts it live ("Joining 1PointUSA… 12 s", then "Joined 1PointUSA. Checking it can reach the directory
   site…"). When it works the TV shows **Connected to <network>. Starting the directory…** and that page stays up
   until the directory's window has opened over it (before, it closed at once and left a gap).

This only happens for a Pi that's never gotten online at all. A Pi that's worked before and just loses its network
keeps the quieter behavior below (cached content, "Reconnecting…") — it never puts up a surprise hotspot on a
screen that's already working; holding the case button 10 seconds (a network reset) brings it back on purpose.
Proven on a real Pi 4 (2026-10-01): it lists nearby networks while hosting the hotspot.
The hotspot is checked every 5 seconds and started again if it has gone (seen after a phone typed a wrong code);
a join that fails deletes the profile it saved and puts the hotspot straight back, so the phone can try again
(DP-05). These reach a Pi only on a newly prepared card (setup runs before a Pi is ever online), or with Update Pi.

### The technician page

`/tech.html`, for 1Point staff in the field, on a phone (**Share → Add to Home Screen** on an iPhone, **Add to home
screen** in Chrome on Android, and it opens like an app). It signs in with the same 1Point login as the console;
anyone else is told it's for 1Point technicians. Pick a screen from the list (or search), and its page shows the Pi's
status in plain words, then:

- **Identify**, **Reload screen**, **Reboot Pi**.
- **Orientation** (called Layout before DP-11): choose one and **Save and restart Pi**, so the picture turns now (dark for about a minute). With no
  enrolled Pi, it just saves the orientation. A screen showing a layout can only be turned to its layout's orientation.
- **Wi-Fi:** **Search for networks** lists what the Pi can pick up, strongest first, and which one it's on. Tap one,
  type its password, **Join**; or **Join a network that isn't listed** for a hidden one. If the Pi can't join it, or
  joins but can't reach the site within a minute, it drops it and goes back to the network it had, and the page says
  why. An answer takes 2 to 3 minutes (the Pi picks it up at its next one-minute check-in). Once a join works, the
  page shows the Pi on the new network straight away, without another search. With a network cable plugged in, the cable stays in charge and the new Wi-Fi is its backup. The password goes
  to the Pi once and is then deleted from the database (about a minute at most); it's never shown back, and the
  audit log records only the network's name.
- **Save for other screens:** tick it when joining, and once the Pi reports the join worked, the network is saved
  (labelled with the building); the page says so on its own line, and Recent actions says so too. The site saves it
  when the Pi reports the join, so the phone can be locked or the page closed while it waits (`supabase/20-save-wifi.sql`).
  A join that fails saves nothing and says so. Every other Pi that can see it then shows it as **Saved**: one tap joins it, and the
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
  A display with no usable HDMI-CEC (most computer monitors and touch displays, e.g. the Beetronics 13") can't be
  switched on or asked, so it always reads "not answering": tick **This display has no HDMI-CEC** in the console's
  **Screen settings** (`supabase/21-no-cec.sql`) and Health stops counting its TV state as a problem (everything else
  still counts). Set that display's own power-on-after-power-loss.
- **Touch screens (DP-08 round 13):** a USB touch panel needs nothing installed: Raspberry Pi OS takes it as a
  multitouch device, and on a single display the touch follows the picture's rotation by itself (proven on the
  Beetronics BEE13TS7M in portrait: its panel is a Weida Hi-Tech CoolTouch, USB 2575:0001). Its touch port is USB-A,
  so it needs a **USB 2.0 A-to-A data cable**: of the cheap cables tried on the bench, one showed nothing at all and
  another connected and dropped every few seconds; test the cable before mounting (`lsusb` should list the panel and
  keep listing it). Every screen is locked against touch (display 2.12.0: no zooming, scrolling, selecting, dragging
  or long-press menus), so a passer-by can't leave the directory in a mess. Mark a touch screen in **Screen settings**
  (**This is a touch screen**, and **Screen size (inches)**, corner to corner, `supabase/25-touch.sql`): the touch
  directory, in a later round, appears only there and sizes its buttons for a finger from the size. Only these screens
  receive a tenant's people (People under tenants, above).
- **The picture:** HDMI 0 always sends a picture at 1080p, even if no TV was detected at start, and the kiosk puts the
  rotation back within 10 seconds if a TV powering up resets it.
- **No network** (a Pi that's been online before): the screen shows the directory and news it last received, with
  "Showing saved information. Reconnecting…" at the bottom. Weather shows for up to 3 hours, then disappears. The
  time and date are hidden until the Pi has reached the site since it started: a Pi 4 has no battery-backed clock, so
  after a power cut its time is wrong until it's online. The clock follows the site's own time, so it's right even
  where a building blocks the usual time service (NTP). Everything returns within about a minute of the network. A
  Pi that's never been online instead offers field Wi-Fi setup (above).
- **No mouse pointer** on screen, with or without a mouse (an invisible pointer theme).
- **No desktop pop-ups:** the desktop's panel and file manager (which Raspberry Pi OS starts anyway) are stopped
  every 10 seconds by the kiosk, since the panel's network plugin is what asked for Wi-Fi passwords on screen; the
  polkit password prompts and pprompt are switched off for the desktop user (DP-05).
- **A quiet restart:** no rainbow square, Raspberry Pi logo or desktop picture (the Pi's own firmware lines may show
  briefly). Then the **start-up animation** (DP-07 round 9c, `public/pi/startup/`): the waytugo logo sweeps in once
  along its road, from far to front, settles exactly as the logo is, and "Starting" appears with dots counting to
  three, over and over, until the directory's window opens over it (never sooner than 10 seconds after the
  animation starts, so a Pi with a fast network still shows the whole sweep; DP-07 round 9d). It plays from the card in its own browser window,
  so it needs no network, and the screen is turned the way it was last time before it starts (a card new to a Pi
  starts landscape and turns once the site answers). The two pictures are the logo split in two (the road and the
  wordmark), so together they are the original pixel for pixel; the font is inside the page.
  If a Pi doesn't have the animation, it shows the **start-up picture** instead (`public/pi/startup.png`, the same logo
  with "Starting…", centred on black; DP-07 round 9), or black. Setup downloads both and checks them (PNGs of at most
  5 MB; the page at most 1 MB and ours; all three animation files or none), and a Pi keeps what it has if a download
  fails. To change them, replace the files on GitHub, then Update Pi on each Pi, and make a new card image.

### Updating Pis in the field

Nothing needs a site visit or a new card:

- **What the screen shows** (the display's code) comes from the site. From display 2.8.0 (now 2.9.0) a screen notices a new
  version within a minute or two of a deploy (`/api/screen` names the live one, `netlify/lib/version.mjs`) and reloads
  itself once; it also reloads at 3 a.m., and **Pi → Reload screen** does it at once. Content (tenants, logos,
  photos, sizes) is live within a minute of saving.
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

Rotation is automatic. Each time the Pi starts, it asks the site how its screen's **Orientation** is set in the console (called Layout before DP-11), and turns the picture to match: Portrait 90°, **Portrait (turned the other way)** 270° for a portrait TV hung the other way round, **Landscape (upside down)** 180°; landscape, new and unassigned Pis stay upright. Without internet it keeps its last answer. So after assigning a Pi or changing an Orientation, use **Pi → Reboot Pi** to turn it. The Pi never reboots on its own; reboot scheduling will come to the console with maintenance windows.

SSH is switched off by setup (from the restart that finishes it), so the Pi opens no ports. The agent covers remote management. Use `--ssh` for a Pi that needs it, and re-run setup without `--ssh` to switch it off again.

Options (`sudo bash setup-kiosk.sh --help` lists them all): `--rotate 0|90|180|270` to fix the turn by hand (for good; the console's Orientation is the usual way), `--ssh` to leave SSH on, `--no-tv` to leave the TV alone, `--no-button` and `--led-gpio N|none` for the case button and light, `--connect` for Raspberry Pi Connect, `--no-agent` to skip the agent, and `--url` to pin a fixed screen address the old way.

## Remote management (the agent)

Each Pi runs a small agent (`public/pi/agent.py`) that checks in once a minute over HTTPS, on a fixed schedule (a slow check-in never pushes the next one back). Results of console actions go out with the next scheduled check-in; a reboot's or an update's result is kept on the Pi until it's reported. Each check-in is a single database call (`supabase/05-tuning.sql`), because Netlify bills for the time a function spends waiting. The Pi always makes the connection, so no ports are opened. It reports:

- temperature, power (under-voltage), uptime, storage and IP address
- whether the browser is running
- a small screenshot every 5 minutes

Pi health is a 1Point service tool. Owner users see only each screen's Online/Offline dot. The server refuses them all device information, not just the console.

In the console, the **Pi** button on each screen offers Identify, Reload screen, Take screenshot, Reboot Pi, Update agent and Update Pi (see Updating Pis in the field). The technician page adds Wi-Fi search and join (agent 1.6.0).

**Remote support** (agent 1.8.1 or newer; 1.8.0 couldn't start Connect on a real Pi. Pi → More → **Remote support on**): the Pi installs Raspberry Pi Connect if needed, switches it on, and the sign-in link appears under Recent actions. Open it and sign in with 1Point's Raspberry Pi account; the Pi then appears at connect.raspberrypi.com for screen sharing and a remote shell. Connect, like the agent, only connects outward, so no ports open. **Remote support off** when finished. **From agent 1.9.0** (DP-08 round 13) the first Remote support on, which installs Connect and can take several minutes, runs beside the check-ins: the Pi keeps checking in, the Screens list and the Pi panel say **Busy: Remote support on, N min**, and the result arrives under Recent actions when it's done (a second request while it's busy is turned away and says so). The Screens list shows **Remote on** (in blue, so it isn't left on) or **Remote off** for each Pi; for older agents it's read from the last Remote support on or off that went through. The master card stays without Connect or SSH: one password on every card, and Connect's sign-in is per Pi, so neither belongs on a copied image. The Pi actions appear only once the Pi has enrolled (the server refuses them before that). Under **More** are Reset device key, Switch off, and Unassign.

**The console keeps up (DP-10 round 17):** while a Pi panel is open it refreshes every 3 seconds for two minutes after an action (then every 10), and the Screens list behind it now follows each refresh (it used to wait for its own once-a-minute refresh, which skips while a panel is open), so Remote on/off and Busy change as soon as the Pi reports. With the panel closed, a command still waiting for its Pi (pending or sent, under 20 minutes old) keeps the list checking every 10 seconds until it's done; with nothing waiting, nothing extra is fetched. A refresh that fails keeps what was shown instead of blanking the list and freezing the panel. **Agent at a glance (round 17b):** each Pi's line in the Screens list ends with its agent version, **Agent 1.10.0**; a Pi on an older agent than the site serves reads **Agent 1.8.1 · update** in amber (Pi → More → Update agent), and the Pi panel's Agent row says the same. The site's current agent is `CURRENT_AGENT` in `netlify/functions/agent.mjs`, which a test keeps equal to `public/pi/agent.py`.

**The Pi's firmware not answering** (agent 1.9.0; seen on the bench 2026-10-23): the agent reads power and temperature through `vcgencmd`, which asks the Pi's firmware. If the firmware stops answering, `vcgencmd` hangs for good and nothing can stop it; agent 1.8.1 then froze with it (no check-ins, no commands, the case light slow-blinking, a shutdown stuck on it). 1.9.0 gives it 5 seconds, never asks again while a stuck one is still there, carries on checking in, and reports it: **Firmware stuck** in the Screens list, and in the Pi panel **Firmware: Not responding**, with Power shown as unknown. Unplug the Pi for 10 seconds; Reboot may not get through while it's stuck.

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

Uptime comes from a daily summary for each Pi (`device_daily`), kept for 400 days. Each check-in credits the time since the Pi's previous one, if that was 3 minutes ago or less (`supabase/07-uptime.sql`), so small timing differences never show as downtime. A longer gap is an outage and earns nothing, so an outage reads up to a minute longer than it was, never shorter. A new Pi's uptime counts from its first check-in, so it isn't penalized for time before it was installed. A reboot (about a minute) counts as up. The Health tab asks the database for each Pi's 30-day totals in one call, one row per Pi (`supabase/17-hardening.sql`), so it stays complete however many Pis there are (Supabase returns at most 1,000 rows a request). Pi actions are kept for 90 days, plus each Pi's latest five whatever their age; the alert check trims both histories every 10 minutes.

Only those fixed actions exist; the console can't send anything free-form. Update agent and Update Pi install code downloaded from this site over HTTPS, so whoever can change the site (its GitHub repo and Netlify) is trusted with every Pi: keep those accounts on two-factor sign-in. Actions not picked up within an hour are dropped rather than run late.

**Alerts:** recipients and which alerts each gets (offline, low power, running hot) are set in the console, **Pi setup → Alert emails**, which also has **Send test email** (it shows the mail server's answer). The mail server's sign-in stays in Netlify. Every 10 minutes the site checks each Pi. It sends one email when a Pi goes offline, reports under-voltage, or runs at 80°C or hotter, and another when that clears. A Pi's alert state is saved only after the email has gone out, so a failed send is retried on the next run, and problems that already exist are emailed once when the email settings are first added.

**Enrollment:** each Pi has its own key, stored hashed. A registered Pi with no key yet (from the Yodeck report, or after **Reset device key**) accepts its first key only while its enrollment window is open (24 hours, opened from **Pi** in the console). Anyone who knows a Pi's serial can't claim it outside that window.

**New card in an enrolled Pi?** The agent makes a new key, which the site refuses ("key doesn't match") until you use **Reset device key** in the console. That clears the key and opens the enrollment window for 24 hours; the Pi re-enrolls on its next check-in. Each Pi's key is kept on its card in `/var/lib/lobby-agent/identity.json`, with the serial it belongs to.

## Tests

```
npm test                      # server functions, against a fake Supabase (no npm install needed: no dependencies)
node tests/test-server.mjs          # the whole site locally, with sample logins
bash tests/kiosk-rotation-test.sh    # the kiosk: address from the serial, rotation and its watcher, a card moved between Pis, field Wi-Fi setup, the start-up animation (about 5 minutes)
python3 tests/agent-test.py          # the Pi's agent: schedule, results, reboot, updates, keys, Update Pi, Wi-Fi search and join, the status light, remote support (about 2 minutes)
python3 tests/button-test.py         # the case button and status light, with key presses through a pipe (about 20 seconds)
bash tests/setup-test.sh             # setup's options, Wi-Fi import, naming, TV keeper, pointer, HDMI, quiet start, start-up picture and animation, field Wi-Fi setup (seconds)
node tests/browser-checks.mjs        # in Chromium (Playwright): the layout page, the console's Layouts tab and Pictures, the QR block and the phone menu, menus and the menu editor (as the owner, the editor and 1Point), Orientation, the directory still working (about three minutes; SHOTS=<folder> also saves screenshots of the menu editor)
node tests/browser-checks.mjs --compare <older public/>   # also: directory screens drawn exactly as by an older copy of public/
bash tests/sql-test.sh               # every supabase/ file from scratch on a local PostgreSQL 16, each check after its file and again at the end (PGHOST/PGPORT/PGUSER)
```

The browser checks and the SQL runner joined the repo in DP-11 (before that they were rebuilt in each chat). The SQL
runner uses `tests/sql/supabase-standin.sql`, a stand-in for Supabase's roles and `auth` schema.

Local sample logins: `scot@1pointusa.com / admin-pass`, `leighann@barber.test / owner-pass`, `editor@barber.test / editor-pass`.

## Files

```
public/             screen (index.html, display.*; board.* for a layout; screen-core.js, what every screen does, shared by both; layout-format.mjs, the layout format; menu-format.mjs, the menu format), sign-in, console (+ console-devices.js, console-setup.js, console-layouts.js), editor, menu editor (menu-edit.*), technician page (tech.*), shared auth.js
netlify/functions/  screen, users, config, weather, news, traffic, togo (the Directory to Go page), menu (Take this menu with you: /m/<code> and /api/menu), agent, devices, networks, alert-settings, alerts, layouts (check, preview, publish, roll back; upload and remove pictures; make lists from a layout), pictures (the menu editor's), shops (copy a shop into an account, T0), sample (sample links: /s/<name> and /api/sample, T0)
netlify/lib/        Supabase client (and Storage), RSS reader, pictures (images.mjs: what a file really is), shared helpers
supabase/           database schema (01 to 35, run in order), starting data, check queries, setup guide
migration/          the Yodeck/Wix transcription the starting data was built from
public/pi/          setup-kiosk.sh, agent.py, startup.png (the start-up picture) and startup/ (the start-up animation), served by the site so Pis can download them
layouts/            layouts written as data (Donut Joe's Pelham; Donut Joe's counter board, 55" landscape, and the same board on its lists, E2b; the 32" portrait chalkboard, E2d, one file since E2e) and the menu source; not deployed, pasted into the console
tests/              function tests, fake Supabase, local test server, browser checks, the SQL runner and its Supabase stand-in
```
