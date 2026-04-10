// remote/translate.js — EnjoySubs AI Translation Module
// Handles proximity-based source language selection, Google/DeepL routing,
// chunked translation, and MongoDB caching.

// ── Language Proximity Map ─────────────────────────────────────
// Based on linguistic distance research. Closer languages produce
// better machine translation (same grammar, shared vocab, etc).
const PROXIMITY_MAP = {
  KO:      ["JA", "ZH", "ZH-TW", "EN", "ES", "FR", "PT", "DE"],
  JA:      ["KO", "ZH", "ZH-TW", "EN", "ES", "FR", "PT", "DE"],
  ZH:      ["JA", "KO", "ZH-TW", "EN", "ES", "FR", "PT"],
  "ZH-TW": ["JA", "KO", "ZH", "EN", "ES", "FR", "PT"],
  EN:      ["FR", "DE", "ES", "PT", "IT", "NL", "KO", "JA"],
  FR:      ["ES", "PT", "IT", "EN", "DE", "NL", "KO", "JA"],
  ES:      ["PT", "IT", "FR", "EN", "DE", "KO", "JA"],
  DE:      ["NL", "FR", "EN", "ES", "PT", "IT"],
  PT:      ["ES", "IT", "FR", "EN", "DE"],
  IT:      ["ES", "PT", "FR", "EN", "DE"],
  NL:      ["DE", "FR", "EN", "ES"],
  AR:      ["EN", "FR", "ES", "DE"],
  TH:      ["EN", "KO", "JA", "ZH"],
  VI:      ["EN", "KO", "JA", "ZH"],
  ID:      ["EN", "KO", "JA", "ZH"],
};

function pickBestSource(targetLang, availableLangs) {
  const candidates = availableLangs.filter(l =>
    l !== targetLang && !l.startsWith(targetLang.split("-")[0])
  );
  const priority = PROXIMITY_MAP[targetLang] || ["EN"];
  for (const lang of priority) {
    const match = candidates.find(l => l === lang || l.startsWith(lang + "-"));
    if (match) return match;
  }
  return candidates[0] || availableLangs[0];
}

// ── API Routing ────────────────────────────────────────────────
const ASIAN_LANGS = new Set(["KO", "JA", "ZH", "ZH-TW", "AR", "TH", "VI", "ID"]);

function chooseAPI(sourceLang, targetLang) {
  if (ASIAN_LANGS.has(targetLang) || ASIAN_LANGS.has(sourceLang)) return "google";
  if (!process.env.DEEPL_API_KEY) return "google";
  return "deepl";
}

// ── Google Translate ───────────────────────────────────────────
async function googleTranslate(texts, sourceLang, targetLang) {
  const key = process.env.GOOGLE_TRANSLATE_API_KEY;
  if (!key) throw new Error("GOOGLE_TRANSLATE_API_KEY not set");

  const BATCH_LIMIT = 128;
  const src = sourceLang.split("-")[0].toLowerCase();
  const tgt = targetLang.split("-")[0].toLowerCase();

  // Split into batches of 128 (Google API limit)
  const batches = [];
  for (let i = 0; i < texts.length; i += BATCH_LIMIT) {
    batches.push(texts.slice(i, i + BATCH_LIMIT));
  }

  const results = [];
  for (const batch of batches) {
    const response = await fetch(
      `https://translation.googleapis.com/language/translate/v2?key=${key}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          q: batch,
          source: src,
          target: tgt,
          format: "text",
        }),
      }
    );

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`Google Translate API error ${response.status}: ${err}`);
    }

    const data = await response.json();
    results.push(...data.data.translations.map(t => t.translatedText));
  }

  return results;
}

// ── DeepL Translate ────────────────────────────────────────────
async function deeplTranslate(texts, sourceLang, targetLang) {
  const key = process.env.DEEPL_API_KEY;
  if (!key) throw new Error("DEEPL_API_KEY not set");

  const response = await fetch("https://api.deepl.com/v2/translate", {
    method: "POST",
    headers: {
      Authorization: `DeepL-Auth-Key ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      text: texts,
      source_lang: sourceLang.split("-")[0].toUpperCase(),
      target_lang: targetLang.toUpperCase(),
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`DeepL API error ${response.status}: ${err}`);
  }

  const data = await response.json();
  return data.translations.map(t => t.text);
}

// ── Batch Translation (timestamps are sacred) ──────────────────
const LINE_PLACEHOLDER = ' |||BR||| ';

async function translateBatch(cues, sourceLang, targetLang, api) {
  // Replace newlines with placeholder so translation APIs preserve line structure
  const texts = cues.map(c => c.text.replace(/\n/g, LINE_PLACEHOLDER));

  let translatedTexts;
  if (api === "google") {
    translatedTexts = await googleTranslate(texts, sourceLang, targetLang);
  } else {
    translatedTexts = await deeplTranslate(texts, sourceLang, targetLang);
  }

  // Restore newlines from placeholder, then smart-break long lines
  return cues.map((cue, i) => ({
    text: smartBreak((translatedTexts[i] || cue.text).replace(/\s*\|\|\|BR\|\|\|\s*/g, '\n')),
    begin: cue.begin,
    end: cue.end,
  }));
}

// Break long single-line text into two lines near the middle at a natural point
function smartBreak(text) {
  if (text.includes('\n')) return text; // already has line breaks
  // Detect CJK text (Korean, Japanese, Chinese)
  const isCJK = /[\u3000-\u9fff\uac00-\ud7af\uff00-\uffef]/.test(text);
  const minLen = isCJK ? 15 : 40;
  if (text.length < minLen) return text; // short enough for one line

  const mid = Math.floor(text.length / 2);

  // 1) Try to break at natural punctuation near the middle
  const punctuation = isCJK
    ? [' ', '、', '，', '。', '」', '）', ')', ',', '.', '!', '?', '！', '？']
    : [' ', ',', '.', ';', '!', '?', ':', '-'];
  let bestPos = -1, bestDist = Infinity;
  for (let i = 0; i < text.length; i++) {
    if (punctuation.includes(text[i])) {
      const dist = Math.abs(i - mid);
      if (dist < bestDist) { bestDist = dist; bestPos = i; }
    }
  }
  if (bestPos > 0 && bestPos < text.length - 1) {
    return text.slice(0, bestPos + 1).trim() + '\n' + text.slice(bestPos + 1).trim();
  }

  // 2) For CJK with no punctuation, just break at the midpoint
  if (isCJK && text.length >= minLen) {
    return text.slice(0, mid) + '\n' + text.slice(mid);
  }

  return text;
}

// ── Chunked Translation (3 parallel chunks for long content) ───
async function translateWithChunks(cues, sourceLang, targetLang, api) {
  if (cues.length < 200) {
    return await translateBatch(cues, sourceLang, targetLang, api);
  }

  const size = Math.ceil(cues.length / 3);
  const chunks = [
    cues.slice(0, size),
    cues.slice(size, size * 2),
    cues.slice(size * 2),
  ];

  const [c1, c2, c3] = await Promise.all(
    chunks.map(chunk => translateBatch(chunk, sourceLang, targetLang, api))
  );

  return [...c1, ...c2, ...c3];
}

// ── Main Handler ───────────────────────────────────────────────
async function handleTranslate(req, res, db) {
  try {
    const { showId, episodeId, targetLang, availableLangs,
            subtitleCues, subALang } = req.body;

    if (!showId || !episodeId || !targetLang || !availableLangs || !Array.isArray(availableLangs)) {
      return res.writeHead(400, { "Content-Type": "application/json" }),
             res.end(JSON.stringify({ error: "Missing required fields" }));
    }

    // Use the actual language of the cues the client sent, not proximity-picked
    const sourceLang = subALang || pickBestSource(targetLang, availableLangs);
    const cacheKey = `${showId}_${episodeId}_${sourceLang}_${targetLang}`;

    // 1. Check cache
    const cached = await db.collection("translations").findOne({ cache_key: cacheKey });
    if (cached) {
      await db.collection("translations").updateOne(
        { cache_key: cacheKey },
        {
          $inc: { hit_count: 1 },
          $set: {
            last_accessed_at: new Date(),
            expires_at: new Date(Date.now() + 180 * 24 * 60 * 60 * 1000),
          },
        }
      );
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({
        translatedCues: cached.translated_cues,
        sourceLang,
        fromCache: true,
      }));
    }

    // 2. Get source cues — use whatever the extension sent
    const cues = (Array.isArray(subtitleCues) && subtitleCues.length > 0)
      ? subtitleCues
      : null;

    if (!cues || cues.length === 0) {
      res.writeHead(400, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({
        error: "No source subtitle cues provided. Load a native subtitle first.",
      }));
    }

    // 3. Translate
    const api = chooseAPI(sourceLang, targetLang);
    const translatedCues = await translateWithChunks(cues, sourceLang, targetLang, api);

    // 4. Save to cache
    await db.collection("translations").insertOne({
      cache_key: cacheKey,
      translated_cues: translatedCues,
      source_lang: sourceLang,
      target_lang: targetLang,
      hit_count: 1,
      created_at: new Date(),
      expires_at: new Date(Date.now() + 180 * 24 * 60 * 60 * 1000),
      last_accessed_at: new Date(),
    });

    // 5. Log analytics
    await db.collection("translation_requests").insertOne({
      timestamp: new Date(),
      cache_key: cacheKey,
      from_cache: false,
      source_lang: sourceLang,
      target_lang: targetLang,
      cue_count: translatedCues.length,
      api_used: api,
    });

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ translatedCues, sourceLang, fromCache: false }));

  } catch (err) {
    console.error("[translate] Error:", err.message);
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Translation failed: " + err.message }));
  }
}

// ── Compliance: purge all translations for a show ──────────────
async function purgeShow(showId, db) {
  const result = await db.collection("translations").deleteMany({
    cache_key: new RegExp(`^${showId}_`),
  });
  return result.deletedCount;
}

// ── Database Setup: create indexes ─────────────────────────────
async function ensureIndexes(db) {
  const translations = db.collection("translations");
  await translations.createIndex({ cache_key: 1 }, { unique: true });
  await translations.createIndex({ expires_at: 1 }, { expireAfterSeconds: 0 });
  await translations.createIndex({ source_lang: 1, target_lang: 1 });
  await translations.createIndex({ hit_count: -1 });
  console.log("  [translate] MongoDB indexes ready");
}

module.exports = {
  handleTranslate,
  purgeShow,
  ensureIndexes,
  pickBestSource,
  chooseAPI,
  PROXIMITY_MAP,
};
