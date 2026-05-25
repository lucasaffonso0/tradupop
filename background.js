const CACHE_TTL_MS = 60 * 60 * 1000;
const CACHE_MAX_ITEMS = 500;
const CACHE_SCHEMA_VERSION = "v3";
const translationCache = new Map();

// ── Persistência do cache no service worker MV3 ──
// O service worker é encerrado após ~30s de inatividade; o cache em memória
// seria destruído. Usamos chrome.storage.session para sobreviver às suspensões.
(async () => {
  try {
    const stored = await chrome.storage.session.get("translationCache");
    const entries = stored?.translationCache;
    if (Array.isArray(entries)) {
      const now = Date.now();
      for (const [k, v] of entries) {
        if (v?.timestamp && now - v.timestamp <= CACHE_TTL_MS) {
          translationCache.set(k, v);
        }
      }
    }
  } catch { /* storage.session indisponível em contextos de teste */ }
})();

function persistCache() {
  try {
    chrome.storage.session.set({ translationCache: [...translationCache.entries()] });
  } catch { }
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: "tradupop-translate",
    title: "Traduzir com TradupPop",
    contexts: ["selection"],
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== "tradupop-translate" || !tab?.id) return;
  chrome.tabs.sendMessage(tab.id, {
    type: "TRANSLATE_SELECTION",
    text: info.selectionText,
  });
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "TRANSLATE_TEXT") {
    return;
  }

  const text = (message.text || "").trim();
  if (!text) {
    sendResponse({ ok: false, error: "Texto vazio." });
    return;
  }

  chrome.storage.local.get(["sourceLang", "targetLang"], (prefs) => {
    const sl = prefs.sourceLang || "en";
    const tl = prefs.targetLang || "pt";
    translate(text, sl, tl)
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) => {
        sendResponse({
          ok: false,
          error: error?.message || "Erro na tradução."
        });
      });
  });

  return true;
});

const LANG_CODE_RE = /^[a-zA-Z]{2,3}(-[a-zA-Z]{2,4})?$/;

async function translate(text, sl = "en", tl = "pt") {
  // Valida códigos de idioma antes de qualquer uso em URLs
  if (!LANG_CODE_RE.test(sl) || !LANG_CODE_RE.test(tl)) {
    throw new Error("Código de idioma inválido.");
  }

  const cacheKey = normalizeCacheKey(text, sl, tl);
  const cached = getFromCache(cacheKey);
  if (cached) return cached;

  let result;
  try {
    result = await translateWithGoogle(text, sl, tl);
  } catch (_error) {
    console.warn("[TradupPop] Google Translate falhou, usando fallback:", _error?.message);
    result = await translateWithMyMemory(text, sl, tl);
  }

  setInCache(cacheKey, result);
  return result;
}

async function translateWithGoogle(text, sl = "en", tl = "pt") {
  const url = new URL("https://translate.googleapis.com/translate_a/single");
  url.searchParams.set("client", "gtx");
  url.searchParams.set("sl", sl);
  url.searchParams.set("tl", tl);
  url.searchParams.append("dt", "t");
  url.searchParams.append("dt", "bd");
  url.searchParams.append("dt", "md");
  url.searchParams.append("dt", "rm");
  url.searchParams.append("dt", "ex");
  url.searchParams.set("q", text);

  const response = await fetch(url.toString());
  if (!response.ok) {
    throw new Error(`Google Translate indisponível (${response.status}).`);
  }

  const data = await response.json();
  const segments = Array.isArray(data?.[0]) ? data[0] : [];
  const translated = segments.map((s) => s?.[0] || "").join("").trim();

  if (!translated) {
    throw new Error("Google Translate sem resultado.");
  }

  // Cache do resultado de isSingleEnglishWord para evitar 3 chamadas redundantes
  const isSingleWord = isSingleEnglishWord(text);

  const alternatives = isSingleWord
    ? extractAlternativeTranslations(data, translated, text)
    : [];
  const dictionary = isSingleWord
    ? extractDictionaryEntries(data, text)
    : [];
  const examples = extractExamples(data);
  let phonetic = extractPhonetic(data);

  if (!phonetic && isSingleWord && sl === "en") {
    phonetic = await fetchPhoneticFallback(text);
  }

  return { translated, alternatives, dictionary, examples, phonetic };
}

async function translateWithMyMemory(text, sl = "en", tl = "pt") {
  const url = new URL("https://api.mymemory.translated.net/get");
  url.searchParams.set("q", text);
  url.searchParams.set("langpair", `${sl}|${tl}`);

  const response = await fetch(url.toString());
  if (!response.ok) {
    throw new Error(`Serviço alternativo indisponível (${response.status}).`);
  }

  const data = await response.json();
  const translated = (data?.responseData?.translatedText || "").trim();

  if (!translated) {
    throw new Error("Não foi possível traduzir agora. Tente novamente.");
  }

  const matches = Array.isArray(data?.matches) ? data.matches : [];
  const alternatives = [];

  for (const match of matches) {
    const candidate = (match?.translation || "").trim();
    if (candidate && candidate.toLowerCase() !== translated.toLowerCase()) {
      alternatives.push(candidate);
    }
    if (alternatives.length >= 6) {
      break;
    }
  }

  return {
    translated,
    alternatives: isSingleEnglishWord(text) ? dedupe(alternatives) : [],
    dictionary: [],
    examples: [],
    phonetic: ""
  };
}

async function fetchPhoneticFallback(word) {
  try {
    const res = await fetch(`https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(word)}`);
    if (!res.ok) return "";
    const data = await res.json();
    const phonetics = data?.[0]?.phonetics || [];
    const found = phonetics.find(p => p.text && p.text.trim());
    return found ? found.text.trim() : "";
  } catch {
    return "";
  }
}

function extractPhonetic(data) {
  // Posição primária: data[0][i][3] (romanização por segmento)
  const segments = Array.isArray(data?.[0]) ? data[0] : [];
  const fromSegments = segments
    .map((segment) => (typeof segment?.[3] === "string" ? segment[3].trim() : ""))
    .filter(Boolean)
    .join(" ")
    .trim();

  if (fromSegments) return fromSegments;

  // Posição secundária conhecida: data[3] (pronúncia do idioma de origem)
  if (typeof data?.[3] === "string" && data[3].trim()) {
    return data[3].trim();
  }

  return "";
}

function isSingleEnglishWord(text) {
  return /^\p{L}[\p{L}'-]*$/u.test((text || "").trim());
}

function extractAlternativeTranslations(data, primaryTranslation, sourceText) {
  const alternatives = [];
  const primary = (primaryTranslation || "").toLowerCase();
  const source = (sourceText || "").trim().toLowerCase();

  const dictEntries = Array.isArray(data?.[1]) ? data[1] : [];
  for (const entry of dictEntries) {
    const terms = Array.isArray(entry?.[1]) ? entry[1] : [];
    for (const term of terms) {
      const value = Array.isArray(term) ? term[0] : term;
      pushCandidate(alternatives, value, primary, source);
    }
  }

  return dedupe(alternatives).slice(0, 5);
}

function dedupe(list) {
  const seen = new Set();
  const unique = [];

  for (const item of list) {
    const key = item.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(item);
  }

  return unique;
}

function pushCandidate(target, value, primary, source) {
  const text = String(value || "").trim();
  if (!text) return;

  const normalized = text.toLowerCase();
  if (normalized === primary || normalized === source) return;

  if (!/^[\p{L}\s'-]+$/u.test(text)) return;
  if (text.length < 2 || text.length > 40) return;

  target.push(text);
}

function extractDictionaryEntries(data, sourceText) {
  const dictEntries = Array.isArray(data?.[1]) ? data[1] : [];
  const source = (sourceText || "").trim().toLowerCase();
  const groups = [];

  for (const entry of dictEntries) {
    const pos = String(entry?.[0] || "").trim();
    const terms = Array.isArray(entry?.[1]) ? entry[1] : [];
    const reverse = Array.isArray(entry?.[2]) ? entry[2] : [];
    const byEnglish = new Map();

    for (let i = 0; i < terms.length; i += 1) {
      const pt = String(terms[i] || "").trim();
      if (!pt) continue;

      const englishTerms = extractSynonyms(reverse[i], source);
      for (const en of englishTerms) {
        const key = en.toLowerCase();
        if (!byEnglish.has(key)) {
          byEnglish.set(key, { en, pts: new Set() });
        }
        byEnglish.get(key).pts.add(pt);
      }
    }

    const items = [];
    for (const row of byEnglish.values()) {
      items.push({ en: row.en, pts: Array.from(row.pts).slice(0, 6) });
      if (items.length >= 4) break;
    }

    if (items.length > 0) {
      groups.push({ pos: pos || "outros", items });
    }

    if (groups.length >= 2) break;
  }

  return groups;
}

function extractExamples(data) {
  if (!Array.isArray(data)) return [];

  const examples = [];

  // Começa em i=1 para pular data[0] (segmentos de tradução)
  // Exemplos estão tipicamente em data[5] no cliente GTX
  for (let i = 1; i < data.length; i++) {
    const block = data[i];
    if (!Array.isArray(block) || !Array.isArray(block[0])) continue;

    for (const item of block[0]) {
      const sentence = String(item?.[0] || "").trim();
      if (!sentence || !sentence.includes("<b>")) continue;
      // Remove todas as tags exceto <b>/<b>; strip atributos de <b> por segurança
      const clean = sentence
        .replace(/<b[^>]*>/gi, "<b>")
        .replace(/<\/b>/gi, "</b>")
        .replace(/<[^>]+>/g, "")
        .trim();
      if (clean.length > 10 && clean.length < 250) {
        examples.push(clean);
      }
      if (examples.length >= 3) break;
    }

    if (examples.length > 0) break;
  }

  return examples;
}

function extractSynonyms(reverseEntry, source) {
  const raw = Array.isArray(reverseEntry?.[1]) ? reverseEntry[1] : [];
  const out = [];

  for (const item of raw) {
    const term = String(item || "").trim();
    if (!term) continue;
    if (term.toLowerCase() === source) continue;
    if (!/\p{L}/u.test(term)) continue;
    out.push(term);
    if (out.length >= 6) break;
  }

  return dedupe(out);
}

function normalizeCacheKey(text, sl = "en", tl = "pt") {
  return `${CACHE_SCHEMA_VERSION}:${sl}:${tl}:${(text || "").trim().toLowerCase()}`;
}

function getFromCache(key) {
  const entry = translationCache.get(key);
  if (!entry) return null;

  if (Date.now() - entry.timestamp > CACHE_TTL_MS) {
    translationCache.delete(key);
    return null;
  }

  return entry.value;
}

function setInCache(key, value) {
  if (!key) return;

  // Evita ejetar entrada existente ao atualizar a mesma chave
  if (!translationCache.has(key) && translationCache.size >= CACHE_MAX_ITEMS) {
    const oldestKey = translationCache.keys().next().value;
    if (oldestKey) translationCache.delete(oldestKey);
  }

  translationCache.set(key, { value, timestamp: Date.now() });
  persistCache();
}
