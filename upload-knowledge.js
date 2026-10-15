// ==========================================================
//  upload-knowledge.js — push knowledge.json into Firestore
//  One-time (or whenever you restructure) admin script.
//  Run from the aethel/ folder:
//
//    npm init -y
//    npm install firebase-admin
//    GOOGLE_APPLICATION_CREDENTIALS=./serviceAccount.json node upload-knowledge.js
//
//  serviceAccount.json comes from Firebase console →
//  Project Settings → Service accounts → "Generate new private key".
//  NEVER commit it, NEVER send it to the browser.
// ==========================================================

const fs = require("fs");
const path = require("path");
const admin = require("firebase-admin");

if (!process.env.GOOGLE_APPLICATION_CREDENTIALS) {
  console.error("Set GOOGLE_APPLICATION_CREDENTIALS to your service account JSON first.");
  process.exit(1);
}

const projectId =
  process.argv[2] ||
  JSON.parse(fs.readFileSync(process.env.GOOGLE_APPLICATION_CREDENTIALS, "utf8")).project_id;

admin.initializeApp({ projectId });

(async () => {
  const kb = JSON.parse(fs.readFileSync(path.join(__dirname, "knowledge.json"), "utf8"));
  const db = admin.firestore();
  const batch = db.batch();

  for (const topic of kb.topics) {
    const ref = db.collection("topics").doc(topic.id);
    batch.set(ref, {
      keywords: topic.keywords || [],
      patterns: topic.patterns || [],
      answers: topic.answers || [],
      ...(topic.answers_tl ? { answers_tl: topic.answers_tl } : {}),
      ...(topic.dynamic ? { dynamic: topic.dynamic } : {}),
    });
  }

  batch.set(db.collection("config").doc("app"), {
    minScore: kb.meta?.match_rules?.min_score ?? 1,
    version: kb.meta?.version || "0.0.0",
    syncedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  batch.set(db.collection("config").doc("fallback"), {
    answers: kb.fallback?.answers || [],
    description: kb.fallback?.description || "",
  });

  await batch.commit();
  console.log(`Done: pushed ${kb.topics.length} topics + 2 config docs to Firestore (${projectId}).`);
  process.exit(0);
})().catch((err) => {
  console.error("Upload failed:", err.message);
  process.exit(1);
});
