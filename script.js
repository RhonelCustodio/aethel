// ==========================================================
//  Aethel — prompt box + local knowledge base
//  No real AI yet: replies come from knowledge.json,
//  matched with the rules documented in its meta.match_rules.
//  Display imitates ChatGPT: your prompt right-aligned,
//  Aethel's reply as plain full-width text, composer at bottom.
// ==========================================================

const form = document.getElementById("prompt-form");
const input = document.getElementById("prompt-input");
const sendBtn = document.getElementById("send-btn");
const col = document.getElementById("col");
const brand = document.getElementById("brand");
const topbar = document.getElementById("topbar");
const newChatBtn = document.getElementById("new-chat-btn");
const chat = document.getElementById("chat");
const historyBtn = document.getElementById("history-btn");
const historyPanel = document.getElementById("history-panel");
const historyList = document.getElementById("history-list");

let started = false; // true once the conversation begins

// ----------------------------------------------------------
//  Knowledge sources — database (Firestore) and/or JSON file
//  Sources are tried in order until one works:
//    1. Firestore            (only when provider === "firestore")
//    2. knowledge.json on GitHub raw
//    3. knowledge.json bundled with the site (local copy)
//  The rest of the app only ever sees a `knowledge` object,
//  so switching brains never touches the UI or the matcher.
//  See README-FIRESTORE.md for the ~10-minute setup.
// ----------------------------------------------------------
const KB_SOURCE = Object.assign(
  {
    provider: "file", // "file" | "firestore"

    firestore: {
      projectId: "YOUR_FIREBASE_PROJECT_ID",
      topicsCollection: "topics",  // one doc per topic
      configCollection: "config",  // "app" + "fallback" docs
    },

    file: {
      cloudUrl: "https://raw.githubusercontent.com/YOUR_GITHUB_USERNAME/aethel/main/knowledge.json",
      localCopy: "knowledge.json",
    },
  },
  window.AETHEL_KB || {} // optional per-deployment override
);

let knowledge = null; // loaded below

// ---- Firestore via its REST API (no SDK, no build step) ----
function fsBaseUrl(projectId) {
  return `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents`;
}

// Unwrap Firestore's typed values: {stringValue}, {integerValue}, {arrayValue}…
function fsValue(v) {
  if (!v) return undefined;
  if ("stringValue" in v) return v.stringValue;
  if ("booleanValue" in v) return v.booleanValue;
  if ("integerValue" in v) return Number(v.integerValue);
  if ("doubleValue" in v) return v.doubleValue;
  if ("arrayValue" in v) return (v.arrayValue.values || []).map(fsValue);
  return undefined;
}
function fsFields(doc) {
  const out = {};
  for (const [key, value] of Object.entries(doc.fields || {})) out[key] = fsValue(value);
  return out;
}

async function fetchFsDoc(base, path) {
  const r = await fetch(`${base}/${path}`, { cache: "no-store" });
  if (!r.ok) throw new Error("HTTP " + r.status);
  return r.json();
}

async function loadFromFirestore() {
  const { projectId, topicsCollection, configCollection } = KB_SOURCE.firestore;
  const base = fsBaseUrl(projectId);

  const list = await fetchFsDoc(base, `${topicsCollection}?pageSize=500`);
  if (!Array.isArray(list.documents)) throw new Error("collection is empty — add docs in the console or run upload-knowledge.js");

  // One Firestore doc = one topic, same shape as knowledge.json entries
  const topics = list.documents
    .map((d) => {
      const f = fsFields(d);
      return {
        id: f.id || d.name.split("/").pop(),
        keywords: f.keywords || [],
        patterns: f.patterns || [],
        answers: f.answers || [],
        ...(f.answers_tl ? { answers_tl: f.answers_tl } : {}),
        ...(f.dynamic ? { dynamic: f.dynamic } : {}),
      };
    })
    .filter((t) => t.answers.length > 0 || (t.answers_tl || []).length > 0 || t.dynamic);
  if (!topics.length) throw new Error("no usable topic docs");

  // Optional config docs; sensible defaults when they're missing
  let minScore = 1;
  let fallbackAnswers = {
    en: ["I don't know that one yet — my knowledge base is small."],
    tl: ["Hindi ko pa alam 'yan. May maliit akong knowledge base."],
  };
  try {
    const f = fsFields(await fetchFsDoc(base, `${configCollection}/app`));
    if (typeof f.minScore === "number") minScore = f.minScore;
  } catch { /* keep defaults */ }
  try {
    const f = fsFields(await fetchFsDoc(base, `${configCollection}/fallback`));
    if (Array.isArray(f.answers) && f.answers.length) fallbackAnswers.en = f.answers;
    if (Array.isArray(f.answers_tl) && f.answers_tl.length) fallbackAnswers.tl = f.answers_tl;
  } catch { /* keep defaults */ }

  // Return the exact same shape as knowledge.json, so nothing else changes
  return {
    meta: { match_rules: { min_score: minScore } },
    topics,
    fallback: { answers: fallbackAnswers.en, answers_tl: fallbackAnswers.tl },
  };
}

// ---- JSON file source (GitHub raw, or the bundled local copy) ----
async function loadFromFile(url) {
  const r = await fetch(url, { cache: "no-store" }); // skip GitHub's ~5 min cache
  if (!r.ok) throw new Error("HTTP " + r.status);
  const k = await r.json();
  if (!k || !Array.isArray(k.topics) || !k.topics.length) throw new Error("no topics array in the JSON");
  return k;
}

// ---- Source chain: first one that works wins ----
async function loadKnowledge() {
  const fsCfg = KB_SOURCE.firestore;
  const fsConfigured = fsCfg.projectId && !fsCfg.projectId.startsWith("YOUR_");
  const sources = [];

  if (KB_SOURCE.provider === "firestore") {
    if (fsConfigured) sources.push({ label: "Firestore (database)", load: () => loadFromFirestore() });
    else console.warn("Aethel: provider is 'firestore' but projectId isn't configured — using file sources.");
  }
  sources.push(
    { label: "GitHub (cloud file)", load: () => loadFromFile(KB_SOURCE.file.cloudUrl) },
    { label: "the local copy", load: () => loadFromFile(KB_SOURCE.file.localCopy) },
  );

  for (const src of sources) {
    try {
      knowledge = await src.load();
      console.info("Aethel: knowledge loaded from " + src.label + ".");
      return;
    } catch (err) {
      console.warn("Aethel:", src.label + " didn't load —", err.message);
    }
  }
  console.warn("Aethel: no knowledge source available — replies will say so politely.");
}
loadKnowledge();

// Escape text before putting it inside a RegExp
function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Score topics exactly as knowledge.json's match_rules describe:
// whole-word keyword hits (+1 each), regex pattern hits (+2 each).
function findTopic(prompt) {
  const p = prompt.toLowerCase();
  const minScore = knowledge.meta?.match_rules?.min_score ?? 1;
  let best = null;
  let bestScore = 0;

  for (const topic of knowledge.topics) {
    let score = 0;
    for (const kw of topic.keywords) {
      if (new RegExp("\\b" + escapeRegExp(kw.toLowerCase()) + "\\b").test(p)) score += 1;
    }
    for (const pat of topic.patterns || []) {
      if (new RegExp(pat, "i").test(p)) score += 2;
    }
    if (score > bestScore) {
      best = topic;
      bestScore = score;
    }
  }
  return bestScore >= minScore ? best : null;
}

// ---- Language matching: reply in the prompt's language ----
// A prompt counts as Filipino/Taglish when it contains any
// recognizable Tagalog function word (matched per whole word,
// so ordinary English never false-triggers).
const TAGALOG_MARKERS = new Set([
  "ako", "ko", "mo", "niya", "namin", "natin", "nyo", "nila", "siya", "sila", "ikaw", "ka",
  "ng", "ang", "gusto", "ayaw", "alam", "kaya", "pwede", "puwede", "meron", "wala",
  "ano", "anong", "sino", "saan", "kanino", "paano", "bakit", "kailan", "ilan", "gaano",
  "dito", "doon", "diyan", "ganyan", "ganito", "ganoon", "yung", "mga", "parang", "talaga",
  "naman", "lang", "na", "paki", "kasama", "salamat", "kamusta", "kumusta", "musta",
  "paalam", "ate", "kuya", "po", "sige", "sana", "siguro", "baka", "sayo", "niyo",
]);
function detectLang(prompt) {
  const words = prompt.toLowerCase().match(/[a-zñ]+/g) || [];
  return words.some((w) => TAGALOG_MARKERS.has(w)) ? "fil" : "en";
}

// Pick from the language's pool, avoiding an immediate repeat
// (tracked per topic AND per language, so switching languages doesn't collide)
const lastVariant = {};
function pickAnswer(topic, lang) {
  const preferred = lang === "fil" ? topic.answers_tl : topic.answers;
  const other = lang === "fil" ? topic.answers : topic.answers_tl;
  const pool = (preferred && preferred.length) ? preferred : (other || []);
  if (!pool.length) return "";
  const key = (topic.id || "?") + ":" + lang;
  if (pool.length === 1) return pool[0];
  let i = Math.floor(Math.random() * pool.length);
  if (i === lastVariant[key]) i = (i + 1) % pool.length;
  lastVariant[key] = i;
  return pool[i];
}

// The actual "AI": prompt in, reply out (language-matched)
function replyTo(prompt) {
  const lang = detectLang(prompt);
  if (!knowledge) {
    return lang === "fil"
      ? "Hindi ma-load ang brain ko — mula GitHub, Firestore, o local file. I-refresh at subukan ulit."
      : "My brain isn't reachable right now — no knowledge source loaded (database, GitHub, or local file). Try refreshing.";
  }
  const topic = findTopic(prompt);
  if (!topic) {
    return pickAnswer({ id: "fallback", answers: knowledge.fallback?.answers, answers_tl: knowledge.fallback?.answers_tl }, lang)
      || (lang === "fil" ? "Wala pa 'yon sa knowledge base ko." : "I don't know that one yet.");
  }

  // Topics can ask the browser for live data — e.g. the clock
  if (topic.dynamic === "local_time") {
    const now = new Date().toLocaleString(undefined, {
      weekday: "long", year: "numeric", month: "long", day: "numeric",
      hour: "numeric", minute: "2-digit",
    });
    return lang === "fil" ? `Ngayon ay ${now}.` : `It's ${now} right now.`;
  }
  return pickAnswer(topic, lang) || (lang === "fil" ? "Wala pa akong masagot dyan." : "Nothing in my knowledge base for that yet.");
}

// ----------------------------------------------------------
//  Chat history — saved per-device in localStorage
//  Chats persist across "New chat" and page reloads.
//  Newest first; the last-opened chat reopens on load.
// ----------------------------------------------------------
const STORE_KEY = "aethel.chats.v1";
const CURRENT_KEY = "aethel.currentChatId";
const MAX_CHATS = 30;
let chats = [];
let currentChatId = null;

try {
  chats = JSON.parse(localStorage.getItem(STORE_KEY)) || [];
  if (!Array.isArray(chats)) chats = [];
  currentChatId = localStorage.getItem(CURRENT_KEY);
} catch {
  chats = [];
  currentChatId = null;
}

function persist() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(chats));
    if (currentChatId) localStorage.setItem(CURRENT_KEY, currentChatId);
    else localStorage.removeItem(CURRENT_KEY);
  } catch (err) {
    console.warn("Aethel: could not save chat history —", err.message);
  }
}

function findChat(id) {
  return chats.find((c) => c.id === id) || null;
}

function ensureChat() {
  let c = currentChatId && findChat(currentChatId);
  if (!c) {
    c = { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), title: "", startedAt: Date.now(), messages: [] };
    chats.unshift(c);
    if (chats.length > MAX_CHATS) chats.length = MAX_CHATS;
    currentChatId = c.id;
  }
  return c;
}

// Recorded immediately (not when the typing animation finishes),
// so a refresh mid-reply still keeps the full exchange.
function recordMessage(role, text) {
  const c = ensureChat();
  if (role === "user" && !c.title) c.title = text.replace(/\s+/g, " ").trim().slice(0, 48);
  c.messages.push({ role, text });
  persist();
  renderHistory();
}

function fmtDate(ts) {
  const d = new Date(ts);
  const opts = { month: "short", day: "numeric" };
  if (d.getFullYear() !== new Date().getFullYear()) opts.year = "numeric";
  return (
    d.toLocaleDateString(undefined, opts) +
    " · " +
    d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })
  );
}

// ---- History panel ----
const TRASH_SVG =
  '<svg class="size-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/></svg>';

function renderHistory() {
  historyList.innerHTML = "";

  if (!chats.length) {
    const empty = document.createElement("p");
    empty.className = "px-2 py-3 text-center text-[13px] text-white/40";
    empty.textContent = "No chats yet — start typing!";
    historyList.appendChild(empty);
    return;
  }

  for (const c of chats) {
    const row = document.createElement("div");
    row.className =
      "flex items-center gap-1 rounded-xl px-2 py-1.5 transition hover:bg-white/[0.07]" +
      (c.id === currentChatId ? " bg-white/[0.05]" : "");

    const openBtn = document.createElement("button");
    openBtn.type = "button";
    openBtn.className = "min-w-0 flex-1 text-left";
    const title = document.createElement("p");
    title.className = "truncate text-[13px] leading-5 text-white/85";
    title.textContent = c.title || "New chat";
    const meta = document.createElement("p");
    meta.className = "text-[11px] text-white/40";
    meta.textContent = fmtDate(c.startedAt) + " · " + c.messages.length + (c.messages.length === 1 ? " message" : " messages");
    openBtn.append(title, meta);
    openBtn.addEventListener("click", () => {
      restoreChat(c);
      closeHistory();
    });

    const delBtn = document.createElement("button");
    delBtn.type = "button";
    delBtn.setAttribute("aria-label", "Delete chat");
    delBtn.title = "Delete";
    delBtn.className = "grid size-7 shrink-0 place-items-center rounded-lg text-white/25 transition hover:bg-rose-400/10 hover:text-rose-200";
    delBtn.innerHTML = TRASH_SVG;
    delBtn.addEventListener("click", () => {
      chats = chats.filter((x) => x.id !== c.id);
      if (currentChatId === c.id) {
        currentChatId = null;
        resetToEmptyView();
      }
      persist();
      renderHistory();
    });

    row.append(openBtn, delBtn);
    historyList.appendChild(row);
  }
}

function openHistory() {
  renderHistory();
  historyPanel.classList.remove("hidden");
  historyPanel.classList.add("flex");
  historyBtn.classList.add("bg-white/10");
  historyBtn.setAttribute("aria-expanded", "true");
}
function closeHistory() {
  historyPanel.classList.add("hidden");
  historyPanel.classList.remove("flex");
  historyBtn.classList.remove("bg-white/10");
  historyBtn.setAttribute("aria-expanded", "false");
}
historyBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  if (historyPanel.classList.contains("hidden")) openHistory();
  else closeHistory();
});
document.addEventListener("click", (e) => {
  if (!historyPanel.classList.contains("hidden") && !historyPanel.contains(e.target)) closeHistory();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeHistory();
});

// Re-open a saved chat (rendered instantly, no typing animation)
function restoreChat(c) {
  currentChatId = c.id;
  chat.innerHTML = "";
  for (const m of c.messages) {
    if (m.role === "user") addUserMessage(m.text, false);
    else addAssistantMessageStatic(m.text);
  }
  startChat();
  scrollToBottom();
  persist();
}

// ----------------------------------------------------------
//  Conversation view (ChatGPT-style)
// ----------------------------------------------------------

// The top bar shows during a conversation — or whenever history
// exists, so you can always get back to a previous chat.
function syncTopbar() {
  const show = started || chats.length > 0;
  topbar.classList.toggle("flex", show);
  topbar.classList.toggle("hidden", !show);
}

// First message flips the layout: big logo/title out,
// compact header in, composer docks to the bottom.
function startChat() {
  started = true;
  brand.classList.add("hidden");
  col.classList.remove("justify-center", "pb-[14vh]");
  chat.classList.remove("hidden");
  chat.classList.add("flex");
  syncTopbar();
}

// Back to the centered empty state (current chat stays saved)
function resetToEmptyView() {
  started = false;
  chat.innerHTML = "";
  chat.classList.add("hidden");
  chat.classList.remove("flex");
  brand.classList.remove("hidden");
  col.classList.add("justify-center", "pb-[14vh]");
  syncTopbar();
  closeHistory();
}
newChatBtn.addEventListener("click", () => {
  currentChatId = null; // next send starts a new chat
  resetToEmptyView();
  persist();
  input.value = "";
  autoResize();
  updateSendButton();
  input.focus();
});

function scrollToBottom() {
  chat.scrollTo({ top: chat.scrollHeight, behavior: "smooth" });
}

// Your prompt: right-aligned, soft rounded shape (like ChatGPT)
function addUserMessage(text, animate = true) {
  const row = document.createElement("div");
  row.className = "flex justify-end" + (animate ? " motion-safe:animate-fade-up" : "");
  const bubble = document.createElement("p");
  bubble.className =
    "max-w-[85%] whitespace-pre-wrap rounded-[22px] bg-white/10 px-5 py-2.5 text-[15px] leading-6 text-white/90";
  bubble.textContent = text;
  row.appendChild(bubble);
  chat.appendChild(row);
}

// Aethel's reply: plain full-width text, no bubble.
// Starts as a typing indicator, filled in after a short beat.
function addAssistantRow() {
  const row = document.createElement("div");
  row.className = "motion-safe:animate-fade-up";

  const body = document.createElement("p");
  body.className = "whitespace-pre-wrap text-[15px] leading-[1.65] text-white/90";
  body.innerHTML =
    '<span class="inline-flex items-center gap-1.5 py-2" aria-label="Aethel is typing">' +
    '<span class="size-1.5 animate-pulse rounded-full bg-white/60"></span>' +
    '<span class="size-1.5 animate-pulse rounded-full bg-white/60 [animation-delay:150ms]"></span>' +
    '<span class="size-1.5 animate-pulse rounded-full bg-white/60 [animation-delay:300ms]"></span>' +
    "</span>";

  const actions = document.createElement("div");
  actions.className = "mt-1.5 flex items-center gap-0.5";

  row.append(body, actions);
  chat.appendChild(row);
  return { body, actions };
}

// Finished reply with no typing dots — used when restoring history
function addAssistantMessageStatic(text) {
  const row = document.createElement("div");
  row.className = "";
  const body = document.createElement("p");
  body.className = "whitespace-pre-wrap text-[15px] leading-[1.65] text-white/90";
  body.textContent = text;
  const actions = document.createElement("div");
  actions.className = "mt-1.5 flex items-center gap-0.5";
  addCopyButton(actions, text);
  row.append(body, actions);
  chat.appendChild(row);
}

// Small action icons under a finished reply (copy, like ChatGPT)
const ICON_COPY =
  '<svg class="size-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect width="14" height="14" x="8" y="8" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>';
const ICON_DONE =
  '<svg class="size-4 text-emerald-300" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>';

function addCopyButton(actions, text) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.setAttribute("aria-label", "Copy response");
  btn.title = "Copy";
  btn.className =
    "grid size-7 place-items-center rounded-md text-white/35 transition hover:bg-white/10 hover:text-white/85";
  btn.innerHTML = ICON_COPY;
  btn.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      /* clipboard blocked (e.g. no permission) — still show feedback */
    }
    btn.innerHTML = ICON_DONE;
    setTimeout(() => (btn.innerHTML = ICON_COPY), 1200);
  });
  actions.appendChild(btn);
}

// ----------------------------------------------------------
//  Prompt box behavior
// ----------------------------------------------------------

// Adaptive prompt box:
// grows as the prompt gets longer, shrinks when text is deleted.
// Max height = 40% of the screen (set in index.html: max-h-[40vh]),
// after that the box scrolls instead of growing.
function autoResize() {
  input.style.height = "auto"; // reset first so it can also shrink
  const maxHeight = parseFloat(getComputedStyle(input).maxHeight) || window.innerHeight * 0.4;
  input.style.height = Math.min(input.scrollHeight, maxHeight) + "px";
  input.style.overflowY = input.scrollHeight > maxHeight ? "auto" : "hidden";
}

// Send button looks disabled while the prompt box is empty
function updateSendButton() {
  sendBtn.disabled = input.value.trim() === "";
}

// Send the prompt (used by both the Enter key and the send button)
function sendPrompt() {
  const prompt = input.value.trim();
  if (!prompt) return; // nothing to send

  startChat();
  addUserMessage(prompt);
  const reply = replyTo(prompt); // computed now, shown after a short "typing" beat
  recordMessage("user", prompt); // saved right away, even before the animation
  recordMessage("assistant", reply);
  const pending = addAssistantRow();
  scrollToBottom();

  setTimeout(() => {
    pending.body.textContent = reply;
    addCopyButton(pending.actions, reply);
    scrollToBottom();
  }, 400);

  // Clear and reset the prompt box
  input.value = "";
  autoResize();
  updateSendButton();
  input.focus();
}

input.addEventListener("input", () => {
  autoResize();
  updateSendButton();
});

// Re-fit the box when the window is resized or the phone is rotated
window.addEventListener("resize", autoResize);

// Enter = send, Shift + Enter = new line
input.addEventListener("keydown", (event) => {
  // Ignore Enter while choosing characters with an IME (e.g. Japanese/Chinese keyboards)
  if (event.isComposing || event.keyCode === 229) return;

  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault(); // don't add a new line
    sendPrompt();
  }
});

// Send button click (form submit) — no page reload
form.addEventListener("submit", (event) => {
  event.preventDefault();
  sendPrompt();
});

// Initial state
autoResize();
updateSendButton();

// Re-open the chat the user was last on, and reflect history in the top bar
const resumed = currentChatId && findChat(currentChatId);
if (resumed && resumed.messages.length) restoreChat(resumed);
else syncTopbar();
