# Aethel — putting the brain in the cloud (GitHub)

No external AI, no API keys, no backend. `script.js` loads `knowledge.json`
**from your GitHub repo first**, and falls back to the local copy if GitHub
is unreachable. Update the brain by editing one file on GitHub — visitors
get it on their next refresh, with **no site redeploy**.

## Files

| File            | Role                                            |
|-----------------|-------------------------------------------------|
| `index.html`    | The UI (Tailwind via CDN)                       |
| `script.js`     | UI behaviors + the cloud-first knowledge loader |
| `knowledge.json`| The brain: topics, keywords, answers            |

## 1) One-time setup (~5 minutes)

1. **Create a public repo** on GitHub, e.g. `aethel`.
   (It's public because raw file access must be reachable from browsers —
   never put secrets in `knowledge.json`.)
2. **Upload all three files** to the repo root (`main` branch):
   `index.html`, `script.js`, `knowledge.json`.
3. **Publish the site** with GitHub Pages:
   Repo → *Settings* → *Pages* → *Source: Deploy from a branch* →
   branch `main`, folder `/ (root)` → Save.
   Your site is live at `https://YOUR_GITHUB_USERNAME.github.io/aethel/`.
4. **Point Aethel at its brain** — open `script.js`, and in `KB_SOURCE`
   replace the placeholder in `file.cloudUrl`:

   ```js
   cloudUrl: "https://raw.githubusercontent.com/YOUR_GITHUB_USERNAME/aethel/main/knowledge.json",
   ```

   Use your actual username, repo name, and branch
   (`main`; use `master` if that's your default branch).
   (Want the brain in a real database instead of a file? See
   `README-FIRESTORE.md` — Firestore setup, same fallback chain.)

## 2) Updating the brain (day to day)

1. Open `knowledge.json` on GitHub → ✏️ → edit topics/answers → **Commit**.
2. Reload the site — the new content is live. GitHub Pages doesn't even
   need to redeploy for knowledge-only changes.

Ideas for edits: add topics (`keywords` + `patterns` + `answers`), extra
answer variants (they rotate automatically, no immediate repeats), or make
a topic use live browser data by adding `"dynamic": "local_time"` — see the
`time_date` topic for an example.

How replies are chosen (also documented in `knowledge.json → meta`):
the prompt is lowercased; every whole-word keyword hit is +1, every regex
`patterns` hit is +2; highest score above `min_score` wins; otherwise the
`fallback` answers are used. Keep `knowledge.json` valid JSON
(GitHub shows a red squiggle if it isn't).

## How the loader behaves

```
fetch KNOWLEDGE_URL (cache: no-store)   →  use it            [cloud brain]
        ↓ fails (404 / offline / bad JSON)
fetch knowledge.json (bundled copy)     →  use it            [safe fallback]
        ↓ also fails
replies politely say the brain didn't load, page still works
```

`cache: "no-store"` bypasses GitHub's ~5-minute raw-file cache, so commits
show up immediately for fresh page loads.

## Testing locally (before pushing)

From the `aethel` folder:

```bash
python3 -m http.server 8000
```

Then open `http://localhost:8000`. With the placeholder URL unmodified, the
cloud fetch simply fails and the local `knowledge.json` is used — so local
development works with zero setup. Check DevTools → Console: it logs whether
the knowledge came from "GitHub (cloud)" or "the local copy".

## Optional upgrades

- **Version pinning**: replace `main` in the raw URL with a tag or commit
  SHA to freeze the brain's version; switch back to `main` to track edits.
- **Separate brain repo**: keep `knowledge.json` in its own repo so any of
  your projects can share the same brain — just change `KNOWLEDGE_URL`.
- **A second site reading the same knowledge**: point it at the same raw URL.
