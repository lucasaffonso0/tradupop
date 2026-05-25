const CACHE_TTL_MS = 60 * 60 * 1000;
const CACHE_MAX_ITEMS = 500;
const CACHE_SCHEMA_VERSION = "v2";
const translationCache = new Map();

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

async function translate(text, sl = "en", tl = "pt") {
  const cacheKey = normalizeCacheKey(text, sl, tl);
  const cached = getFromCache(cacheKey);
  if (cached) return cached;

  let result;
  try {
    result = await translateWithGoogle(text, sl, tl);
  } catch (_error) {
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

  const alternatives = isSingleEnglishWord(text)
    ? extractAlternativeTranslations(data, translated, text)
    : [];
  const dictionary = isSingleEnglishWord(text)
    ? extractDictionaryEntries(data, text)
    : [];
  const examples = extractExamples(data);

  return { translated, alternatives, dictionary, examples };
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
    examples: []
  };
}

function isSingleEnglishWord(text) {
  // Aceita palavra única em qualquer idioma (inclui acentos e scripts não-latinos)
  return /^\p{L}[\p{L}'-]*$/u.test((text || "").trim());
}

function extractAlternativeTranslations(data, primaryTranslation, sourceText) {
  const alternatives = [];
  const primary = (primaryTranslation || "").toLowerCase();
  const source = (sourceText || "").trim().toLowerCase();

  // Formato comum de dicionário em data[1].
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
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    unique.push(item);
  }

  return unique;
}

function pushCandidate(target, value, primary, source) {
  const text = String(value || "").trim();
  if (!text) {
    return;
  }

  const normalized = text.toLowerCase();
  if (normalized === primary) {
    return;
  }
  if (normalized === source) {
    return;
  }

  // Aceita somente texto plausível de tradução (qualquer idioma).
  if (!/^[\p{L}\s'-]+$/u.test(text)) {
    return;
  }

  if (text.length < 2 || text.length > 40) {
    return;
  }

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
      if (!pt) {
        continue;
      }

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
      items.push({
        en: row.en,
        pts: Array.from(row.pts).slice(0, 6)
      });
      if (items.length >= 4) {
        break;
      }
    }

    if (items.length > 0) {
      groups.push({ pos: pos || "outros", items });
    }

    if (groups.length >= 2) {
      break;
    }
  }

  return groups;
}

function extractExamples(data) {
  // A API retorna exemplos (dt=ex) em índices variáveis dependendo da palavra.
  // Percorre todos os índices da resposta procurando um array de frases.
  if (!Array.isArray(data)) return [];

  const examples = [];

  for (let i = 0; i < data.length; i++) {
    const block = data[i];
    // O bloco de exemplos é um array cujo primeiro elemento é um array de itens
    if (!Array.isArray(block) || !Array.isArray(block[0])) continue;

    for (const item of block[0]) {
      const sentence = String(item?.[0] || "").trim();
      if (!sentence) continue;
      // Só aceita frases que tenham a palavra destacada em <b> (característica dos exemplos)
      if (!sentence.includes("<b>")) continue;
      // Remove outras tags HTML mantendo apenas <b> para highlight
      const clean = sentence.replace(/<(?!\/?(b)\b)[^>]+>/gi, "").trim();
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
  // reverseEntry = [pt_word, [en_syn1, en_syn2, ...], score, ...]
  // Os sinônimos em inglês ficam em reverseEntry[1], não no array raiz
  const raw = Array.isArray(reverseEntry?.[1]) ? reverseEntry[1] : [];
  const out = [];

  for (const item of raw) {
    const term = String(item || "").trim();
    if (!term) {
      continue;
    }
    const low = term.toLowerCase();
    // Aceita qualquer script (latim, cirílico, CJK, etc.)
    if (!/\p{L}/u.test(term)) {
      continue;
    }
    out.push(term);
    if (out.length >= 6) {
      break;
    }
  }

  return dedupe(out);
}

function normalizeCacheKey(text, sl = "en", tl = "pt") {
  return `${CACHE_SCHEMA_VERSION}:${sl}:${tl}:${(text || "").trim().toLowerCase()}`;
}

function getFromCache(key) {
  const entry = translationCache.get(key);
  if (!entry) {
    return null;
  }

  if (Date.now() - entry.timestamp > CACHE_TTL_MS) {
    translationCache.delete(key);
    return null;
  }

  return entry.value;
}

function setInCache(key, value) {
  if (!key) {
    return;
  }

  if (translationCache.size >= CACHE_MAX_ITEMS) {
    const oldestKey = translationCache.keys().next().value;
    if (oldestKey) {
      translationCache.delete(oldestKey);
    }
  }

  translationCache.set(key, {
    value,
    timestamp: Date.now()
  });
}
