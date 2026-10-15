#!/usr/bin/env node
"use strict";
// ==========================================================
//  build-qa-index.js — turn a Kaggle Q→A dataset into qa-index.json
//
//  Usage (from the aethel/ folder):
//    node build-qa-index.js <dataset.csv|.tsv|.txt> [options]
//
//  Options:
//    --q-col NAME   question column name (auto-detected if omitted)
//    --a-col NAME   answer column name (auto-detected if omitted)
//    --max N        keep at most N entries (default 12000)
//    --out FILE     output path (default qa-index.json)
//    --source TEXT  label saved into the index metadata
//
//  Handles: quoted CSV, tab/semicolon-delimited, and plain
//  two-column "question<tab>answer" files (e.g. Kaggle
//  "simple dialogs" dialogs.txt) with or without a header row.
// ==========================================================

const fs = require("fs");

// Keep this list in sync with the one in script.js
const STOPWORDS = new Set([
    "a", "an", "the", "is", "are", "was", "were", "be", "been", "being", "do", "does", "did",
    "of", "to", "in", "on", "at", "for", "with", "by", "from", "as", "into", "about", "over",
    "after", "before", "and", "or", "but", "if", "then", "than", "so", "because",
    "what", "who", "whom", "whose", "when", "where", "why", "how", "which",
    "i", "you", "he", "she", "it", "we", "they", "me", "him", "her", "them",
    "my", "your", "its", "our", "their", "this", "that", "these", "those",
    "am", "have", "has", "had", "not", "no", "yes", "can", "will", "would",
    "should", "could", "may", "might", "tell", "say", "said", "please", "just",
    "really", "know", "much", "many", "get", "got", "make", "made", "there", "here", "also",
]);

// ---- args ----
const argv = process.argv.slice(2);
const input = argv.find((a) => !a.startsWith("--"));
if (!input) {
    console.error("usage: node build-qa-index.js <dataset-file> [--q-col X] [--a-col Y] [--max N] [--out FILE] [--source TEXT]");
    process.exit(1);
}
function flag(name, def) {
    const i = argv.indexOf("--" + name);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
}
const qCol = flag("q-col", null);
const aCol = flag("a-col", null);
const maxEntries = parseInt(flag("max", "12000"), 10);
const outPath = flag("out", "qa-index.json");
const source = flag("source", input);

// ---- delimited-text parser (handles quoted fields) ----
function detectDelimiter(text) {
    const firstLine = text.slice(0, text.indexOf("\n") > 0 ? text.indexOf("\n") : text.length);
    const count = (ch) => (firstLine.match(new RegExp("\\" + ch, "g")) || []).length;
    const scores = { "\t": count("\t"), ",": count(","), ";": count(";"), "|": count("|") };
    return Object.entries(scores).sort((a, b) => b[1] - a[1])[0][1] > 0
        ? Object.entries(scores).sort((a, b) => b[1] - a[1])[0][0]
        : ",";
}

function parseDelimited(text, delim) {
    const rows = [];
    let row = [], field = "", inQuotes = false;
    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (inQuotes) {
            if (c === '"') {
                if (text[i + 1] === '"') { field += '"'; i++; } else inQuotes = false;
            } else field += c;
        } else if (c === '"') inQuotes = true;
        else if (c === delim) { row.push(field); field = ""; }
        else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
        else if (c !== "\r") field += c;
    }
    if (field || row.length) { row.push(field); rows.push(row); }
    return rows.filter((r) => r.some((x) => x.trim() !== ""));
}

// ---- normalize ----
// Common abbreviations expanded so queries match full-form dataset
// questions (extend this map to fit your dataset's vocabulary).
const NORM = [
    [/\bww2\b|\bwwii\b/g, "world war 2"],
    [/\bww1\b|\bwwi\b/g, "world war 1"],
    [/\busa\b/g, "united states"],
    [/\buk\b/g, "united kingdom"],
    [/\bph\b|\bpinoy\b/g, "philippines filipino"],
    [/\btv\b/g, "television"],
];
const collapse = (s) => {
    let t = s.toLowerCase().replace(/\s+/g, " ").trim();
    for (const [re, out] of NORM) t = t.replace(re, out);
    return t;
};
function tokenize(norm) {
    const words = norm.match(/[a-z0-9ñ]+/g) || [];
    return [...new Set(words.filter((w) => !STOPWORDS.has(w)))];
}

// ---- read + pick columns ----
const text = fs.readFileSync(input, "utf8");
const delim = detectDelimiter(text);
const rows = parseDelimited(text, delim);
const Q_HINTS = new Set(["question", "input", "q", "query", "text", "questions", "pattern", "name"]);
const A_HINTS = new Set(["answer", "target", "a", "response", "out", "expected_response", "answers", "reply"]);

let qi = 0, ai = 1;
const first = rows[0].map((c) => collapse(c));
const looksLikeHeader = first.some((c) => Q_HINTS.has(c)) || first.some((c) => A_HINTS.has(c));
if (looksLikeHeader || qCol || aCol) {
    const find = (wanted, hints) => {
        if (wanted) {
            const exact = first.findIndex((c) => c === wanted.toLowerCase());
            if (exact >= 0) return exact;
            const col = parseInt(wanted, 10);
            if (!Number.isNaN(col)) return col;
            throw new Error(`column "${wanted}" not found in header: ${first.join(" | ")}`);
        }
        return first.findIndex((c) => hints.has(c));
    };
    const q = find(qCol, Q_HINTS), a = find(aCol, A_HINTS);
    if (q < 0 || a < 0) throw new Error(`couldn't auto-detect question/answer columns (header: ${first.join(" | ")}). Use --q-col/--a-col.`);
    qi = q; ai = a;
    if (!qCol && !aCol) rows.shift(); // drop the header row
}

// ---- build entries ----
const seen = new Set();
const entries = [];
let dups = 0, skipped = 0;
for (const r of rows) {
    const q = collapse(r[qi] || "");
    let a = (r[ai] || "").replace(/\s+/g, " ").trim();
    if (!q || !a) { skipped++; continue; }
    if (a.length > 800) a = a.slice(0, 800) + "…";
    const key = q.replace(/[^a-z0-9ñ\s]/g, " ").replace(/\s+/g, " ").trim(); // same as runtime norm
    if (seen.has(key)) { dups++; continue; }
    const tokens = tokenize(key);
    if (!tokens.length) { skipped++; continue; } // nothing to match on
    seen.add(key);
    entries.push({ q: key, a, tokens });
    if (entries.length >= maxEntries) break;
}

// ---- write ----
const out = {
    name: "Aethel QA index",
    source,
    builtAt: new Date().toISOString(),
    count: entries.length,
    notes: "Generated by build-qa-index.js from a Kaggle Q→A dataset. Matched by script.js via token similarity (see KB_SOURCE.dataset).",
    entries,
};
fs.writeFileSync(outPath, JSON.stringify(out));
const kb = Math.round(fs.statSync(outPath).size / 1024);
console.log(`✓ ${rows.length} rows read → ${entries.length} entries (${dups} dupes, ${skipped} skipped) → ${outPath} (${kb} KB)`);
console.log(`  question col: "${rows[0] && rows[0][qi] ? String(rows[0][qi]).slice(0, 30) : qi}" | answer col: ${ai}`);
console.log(`  sample: "${entries[0]?.q}" → "${String(entries[0]?.a).slice(0, 60)}…"`);
if (kb > 8000) console.log("  ⚠ index >8MB: consider --max or a smaller dataset for snappy first loads");
