# Snapmake

Snap a photo of what you have, say what you want to make, and get a clear step-by-step plan.

Works for anything: ingredients in a fridge, a sagging cabinet door, a pile of beads, a pet question.

**Live site:** https://oorbitproductivity-oss.github.io/snapmake/

## What it does
- Take a photo (or up to 4) with your camera, upload, drag-and-drop, or paste
- Say the goal ("dinner for two", "fix this hinge", "turn these into a bracelet") and pick a project type
- The AI names what's in the photo, pins tags on it, and writes a plan with:
  - a "what you need" checklist (what you have vs. what to get), plus tools
  - numbered steps with tips, safety warnings, and one-tap timers
  - step-by-step mode: full screen, big text, swipe or arrow keys, read-aloud, screen kept awake
  - follow-up questions ("what can I use instead of butter?")
  - other ideas from the same stuff
- Every plan is saved on your device (Saved drawer). Share or print any plan.
- Installable as an app (PWA)

## How the free AI works
There's no API key and no bill. Snapmake uses [Puter.js](https://docs.puter.com), where each
visitor signs in once to a free Puter account and covers their own AI use. The site owner pays
nothing. Vision models tried in order: `gemini-3.5-flash`, `gpt-5.4-mini`, `claude-sonnet-4-6`.

## Hosting and updates
It's a static site with no build step (`index.html`, `styles.css`, `app.js`), hosted free on
GitHub Pages. Every push to `main` redeploys automatically.

## Run locally
```bash
npx http-server . -p 5178
```
Open `http://localhost:5178`. Add `?demo` to see an example plan, or `?mock` to test the whole
flow with a canned AI answer.
