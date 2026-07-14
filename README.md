# Mise

Everything in its place — a personal meal-planning PWA. Plans a week of dinners
(and optionally breakfast/lunch), reverses the menu into a grocery list, walks
a standing staples/household checklist, and gives you a checkable shopping
list. Installs to your phone's home screen and works offline.

**What this app deliberately does NOT do:** store prices, compare stores, or
touch flyers. That's real, live-judgment work that stays in a chat thread with
Claude — this app only ever hands off a plain categorized list. See
`DATA-MODEL.md` for the full data shapes and the reasoning behind every design
choice.

---

## Quick start (local testing)

Service workers require a real server context — opening `index.html` directly
via `file://` will NOT register the service worker correctly. Serve it locally:

```bash
cd mise
python -m http.server 8000
# or: npx http-server -p 8000
```

Then open `http://localhost:8000` in a browser. On first load the app boots
with an empty state — no seed data ships in this repo (see "Personal data"
below).

## Deploying to GitHub Pages

1. Push this repo to GitHub.
2. Repo Settings → Pages → Deploy from branch → pick `main` (or whichever
   branch) and `/ (root)`.
3. Your app will be live at `https://<username>.github.io/<repo-name>/`.
4. On your phone, open that URL in Safari (iOS) or Chrome (Android), then
   **Share → Add to Home Screen**. From then on it launches as a standalone
   app, not a browser tab.

## Updating the app

The service worker (`sw.js`) uses a **network-first** strategy for everything
in the app shell — it always tries to fetch the latest version first, falling
back to the cached copy only when offline. This means: push a change to
GitHub Pages, reload the app on your phone while online, and you'll see the
update immediately. No manual cache-version bump required for routine changes.

If you ever want to force a hard cache reset (e.g. after a big structural
change), bump the `CACHE_NAME` string at the top of `sw.js` — this invalidates
every previously cached file.

---

## Personal data — how it actually lives

**This repo contains no personal data at all.** No recipes, no names, no
locations, no store info. Every screen boots empty until you either:

- **Import a one-time starter JSON** (built separately, from your own actual
  recipes/pantry/profiles — never committed to this repo), or
- **Build it up manually** through the app's own UI.

From that point on, **all your real data lives only in your phone's browser
storage (IndexedDB)** — recipes, profiles, pantry, menu history, checklist
state, shopping list. Nothing syncs anywhere automatically.

### This means backups are on you

Browser storage on iOS is not guaranteed to survive a phone migration or an
aggressive storage cleanup (this is a known, documented iOS/PWA limitation,
not a bug in this app). **Use the "Export full backup" button on the Settings
screen regularly** — it's front-and-center for exactly this reason. Move the
resulting `.json` file to your computer (AirDrop / Windows-iPhone file share /
whatever you've got working) and keep it somewhere safe. If your phone's local
data is ever lost, importing that same file restores everything.

---

## The AI assist (optional, and it degrades gracefully)

`js/api.js` calls a Cloudflare Worker you already run (holding your Anthropic
API key server-side — this repo's client code never touches the key itself).

**Before this works, edit the `ENDPOINT` constant in `js/api.js`** to point at
your actual Worker URL.

**⚠️ Known limitation, worth fixing before wide use:** as currently
configured, that Worker accepts requests from any origin (no allow-list). This
was a deliberate, informed decision to defer the fix rather than block this
build — see the design conversation for the full reasoning — but if you ever
want to close it, add an origin check to the Worker comparing
`request.headers.get('Origin')` against your actual GitHub Pages domain.

**If the Worker is unreachable** (down, network issue, not yet configured),
every AI-dependent feature degrades to a manual fallback rather than blocking:

- **AI-generated dinner novelty slot** → falls back to a rules-based library
  pick.
- **Breakfast/lunch "Plan" idea** → shows an error toast; plan it manually.
- **"Special" date-night conversation** → shows an error toast; the slot stays
  unplanned until retried or handled manually.
- **Profile free-text notes** ("no cilantro," etc.) → stored as a plain note
  even if the AI can't parse it into a structured restriction.

---

## File structure

```
mise/
├── index.html          # single-page shell
├── manifest.json        # PWA metadata
├── sw.js                 # service worker — network-first, versioned cache
├── version.json          # visible build stamp
├── DATA-MODEL.md         # full schema + design reasoning — read this first
├── icons/
├── css/style.css         # steel/ink/steel-blue palette, one ochre highlight
└── js/
    ├── app.js            # bootstrapper — tab dispatch, boot sequence
    ├── db.js              # IndexedDB — the only place storage logic lives
    ├── api.js             # Cloudflare Worker calls (AI features)
    ├── profiles.js        # profile CRUD, 13-question wizard, AI-notes layer
    ├── recipes.js         # recipe CRUD, rules-based candidate matching
    ├── cycles.js          # weekly cycle (Sun dinner → Sat dinner), day/slot setup
    ├── menu.js            # menu generation, swap workflow, grocery reversal
    ├── mealslots.js       # breakfast/lunch AI ideas, "Special" chat flow
    ├── checklist.js       # standing staples/household checklist
    ├── shoppinglist.js    # full-CRUD shopping list, export/import
    └── backup.js          # whole-app export/import, recipe-library wipe
```

## Core design rules (won't change without a deliberate decision)

1. **Local storage is the only source of truth for personal data.** This repo
   never contains anything identifying.
2. **The app never touches pricing, stores, or flyers.** That's chat's job,
   every time, via the plain categorized export.
3. **Destructive actions scale their friction to what they destroy.** Clearing
   the shopping list is one tap (Shopping tab). Wiping the recipe library is
   buried in Settings and requires typing "DELETE" to confirm.
4. **Every AI feature has a manual fallback.** Nothing in this app requires
   the Worker to be reachable in order to function.
