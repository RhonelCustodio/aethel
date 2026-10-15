# Aethel — non-file knowledge: storing the brain in Firestore

Your site stays a plain static page (no backend, no Firebase SDK, no build).
`script.js` talks to **Firestore's public REST API** with the same `fetch`
pattern it already uses. The loader tries sources in order:

```
provider: "firestore" ?  Firestore (database)  →  GitHub JSON  →  local JSON
provider: "file"      ?                         GitHub JSON  →  local JSON
```

The first source that loads wins; each one that fails is logged to the
browser console. The UI, the scoring rules, and answer rotation never know
or care where the data came from.

## Data model (mirrors knowledge.json, but document-per-topic)

Collection **`topics`** — one document per topic, doc ID = topic id:

```
topics/
  greeting    → keywords: ["hi","hello","kamusta",…]   (string array)
                patterns: ["^\\s*(hi|hey…)"]            (string array)
                answers:  ["Hi! I'm Aethel…", …]        (string array)
                dynamic:  (string, OPTIONAL — e.g. "local_time")
  who_are_you → …
  …
```

Collection **`config`** — two optional documents (defaults apply without them):

```
config/app      → minScore: 1        (number — same as meta.match_rules.min_score)
                  version: "1.0.0"   (string, informational)
config/fallback → answers: ["I don't know that one yet…", …]   (string array)
```

Adding a topic later = **one new document** in the console. Deleting = delete
the doc. That's the real advantage over a JSON file: item-level editing, no
risk of breaking the whole file with one stray comma, and Firestore can later
grow into auth, per-user data, search, etc. without changing the site's code.

## 1) Firebase setup (~5 minutes)

1. Go to https://console.firebase.google.com → **Add project** (any name,
   Analytics off is fine).
2. **Build → Firestore Database → Create database**:
   - Location: `asia-southeast1` (Singapore — closest to you).
   - Start in **production mode** (we open reads with a rule in a second).
3. **Rules** tab → paste → **Publish**:

   ```
   rules_version = '2';
   service cloud.firestore {
     match /databases/{database}/documents {
       match /topics/{topic}   { allow read: if true; allow write: if false; }
       match /config/{config}  { allow read: if true; allow write: if false; }
     }
   }
   ```

   Anyone can *read* the brain (that's what the browser does, like a public
   GitHub file); nobody can *write* through the API. The Firebase console's
   own **Data** tab can still edit — console access bypasses rules — so
   updating knowledge = clicking in the dashboard. **Never put secrets in it.**

## 2) Fill it with data — two options

**Option A — console clicks.** Firestore → Data → Start collection →
`topics`, then "Set auto-ID off" and use the topic id (`greeting` etc.) as
the document ID; add `keywords` / `patterns` / `answers` as *array of
strings* fields. Then collection `config` with docs `app` and `fallback`.

**Option B — one command (recommended).** Put your existing `knowledge.json`
in the site folder, then:

```bash
# get a service account key:
# Firebase console → Project Settings (gear) → Service accounts
# → "Generate new private key" → save as serviceAccount.json (in this folder)

npm init -y
npm install firebase-admin
GOOGLE_APPLICATION_CREDENTIALS=./serviceAccount.json node upload-knowledge.js
```

`upload-knowledge.js` batches all topics + both config docs in one commit.
Delete/never-commit `serviceAccount.json` afterwards (add it to `.gitignore`).

## 3) Point the site at the database

Open `script.js`, in `KB_SOURCE` near the top, change two values:

```js
const KB_SOURCE = Object.assign(
  {
    provider: "firestore",                    // ← was "file"
    firestore: {
      projectId: "YOUR_PROJECT_ID",           // ← from the console URL
      topicsCollection: "topics",
      configCollection: "config",
    },
    …
```

Refresh → DevTools console should say
`Aethel: knowledge loaded from Firestore (database).`
If Firestore is down/misconfigured it falls back to the JSON chain automatically.

Per-deployment override without editing code (optional): set
`window.AETHEL_KB = { provider: "firestore", firestore: {…} }` in a script
tag before `script.js`.

## Day to day

- **Edit a topic:** Firestore console → `topics/greeting` → change `answers`
  → site picks it up on next page load (no redeploy, ever).
- **Add a topic:** new doc with `keywords` + `answers` — that's it, the
  matcher reads whatever exists.
- **Remove a topic:** delete the doc.
- **Version pin:** set `config/app` → `version` so you can tell which brain
  build is live.

## Notes

- **Free tier covers you**: Firestore's free daily quota is ~50k reads;
  loading the brain costs one list query (+2 tiny doc reads) **per page
  load**, so tens of thousands of visits per day are free.
- **Freshness**: data loads on page load, like the file approach. If you
  want replies to update *without* refresh, the upgrade path is swapping the
  REST call for the Firebase JS SDK with `onSnapshot(...)` listeners — real
  time for free, but it adds the SDK script to the page. Say the word and
  I'll wire it.
- **Other databases later**: Supabase (PostgREST), Cloudflare KV/D1,
  PocketBase… same idea — write one `loadFromX()` that returns the
  `{ meta, topics, fallback }` shape and push it onto the `sources` chain.
