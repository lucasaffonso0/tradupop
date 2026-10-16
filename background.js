// Chrome (service worker): carrega dependências via importScripts.
// Firefox (event page): ui-strings.js já foi carregado pela lista background.scripts do manifest.
if (typeof importScripts === "function" && typeof UI_STRINGS === "undefined") {
  importScripts("ui-strings.js");
}

const CACHE_TTL_MS = 60 * 60 * 1000;
const MYMEMORY_CACHE_TTL_MS = 5 * 60 * 1000;
const ERROR_CACHE_TTL_MS = 20 * 1000;
const CACHE_MAX_ITEMS = 500;
const ERROR_CACHE_MAX_ITEMS = 100;
const CACHE_SCHEMA_VERSION = "v5";
const CACHE_STORAGE_PREFIX = "tc:";
const MAX_TEXT_LENGTH = 500;

const LANG_CODE_RE = /^[a-zA-Z]{2,3}(-[a-zA-Z]{2,4})?$/;

// Timeouts cobrem fetch + leitura do corpo
const GOOGLE_TIMEOUT_MS = 2500;
const MYMEMORY_TIMEOUT_MS = 4000;
const PHONETIC_TIMEOUT_MS = 3000;
// Hedging: sem resposta do Google em 1.2s, dispara o MyMemory em paralelo
const HEDGE_DELAY_MS = 1200;
// Se o MyMemory vencer, o Google ainda tem esse prazo (resultado mais rico)
const GOOGLE_GRACE_MS = 300;
// Circuit breaker: após falha do Google, vai direto ao MyMemory por 60s
const GOOGLE_DOWN_MS = 60 * 1000;
const WARM_INTERVAL_MS = 4 * 60 * 1000;
const WARM_TIMEOUT_MS = 2000;

const PHONETIC_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const PHONETIC_NEGATIVE_TTL_MS = 10 * 60 * 1000;
const PHONETIC_MAX_ITEMS = 1000;
const PHONETIC_WAIT_MS = 1500;
const PHONETIC_PERSIST_DELAY_MS = 1000;

const CANCELLED_ERROR = "cancelled";

const translationCache = new Map();
const errorCache = new Map();
const inFlight = new Map();
const slots = new Map();
const phoneticCache = new Map();
const phoneticInFlight = new Map();

let googleDownUntil = 0;
let lastGoogleRequestAt = 0;
let lastWarmAt = 0;

// ── Persistência do cache no service worker MV3 ──
// O service worker é encerrado após ~30s de inatividade; o cache em memória
// seria destruído. Cada entrada vive em storage.session sob `tc:${chave}`.
async function restoreCache() {
  try {
    // Formato antigo (array inteiro numa chave só)
    chrome.storage.session.remove("translationCache")?.catch?.(() => { });
    const stored = (await chrome.storage.session.get(null)) || {};
    const now = Date.now();
    const valid = [];
    const stale = [];
    for (const [storageKey, entry] of Object.entries(stored)) {
      if (!storageKey.startsWith(CACHE_STORAGE_PREFIX)) continue;
      if (!entry?.timestamp || now - entry.timestamp > (entry.ttl || CACHE_TTL_MS)) {
        stale.push(storageKey);
        continue;
      }
      valid.push([storageKey.slice(CACHE_STORAGE_PREFIX.length), entry]);
    }
    // Mais antigos primeiro para manter a ordem do LRU
    valid.sort((a, b) => a[1].timestamp - b[1].timestamp);
    while (valid.length > CACHE_MAX_ITEMS) {
      stale.push(CACHE_STORAGE_PREFIX + valid.shift()[0]);
    }
    for (const [key, entry] of valid) {
      if (!translationCache.has(key)) translationCache.set(key, entry);
    }
    if (stale.length) chrome.storage.session.remove(stale)?.catch?.(() => { });
  } catch { /* storage.session indisponível em contextos de teste */ }
}

const cacheReady = restoreCache();

function persistEntry(key, entry) {
  // Nunca grava antes da restauração terminar
  cacheReady.then(() => {
    try {
      chrome.storage.session.set({ [CACHE_STORAGE_PREFIX + key]: entry })?.catch?.(() => { });
    } catch { }
  });
}

function unpersistEntries(keys) {
  if (!keys.length) return;
  cacheReady.then(() => {
    try {
      chrome.storage.session.remove(keys.map((k) => CACHE_STORAGE_PREFIX + k))?.catch?.(() => { });
    } catch { }
  });
}

// ── Preferências em memória ──
const prefs = { sourceLang: "en", targetLang: "pt" };

function validLang(code) {
  return typeof code === "string" && LANG_CODE_RE.test(code) ? code : "";
}

function wordKeysFrom(list) {
  const keys = new Set();
  for (const item of Array.isArray(list) ? list : []) {
    if (item && typeof item.word === "string" && item.word.trim()) {
      keys.add(item.word.toLowerCase());
    }
  }
  return [...keys];
}

function writeSavedWordKeys(list) {
  try {
    chrome.storage.local.set({ savedWordKeys: wordKeysFrom(list) })?.catch?.(() => { });
  } catch { }
}

async function loadPrefs() {
  try {
    const stored = await chrome.storage.local.get(["sourceLang", "targetLang", "savedWords", "savedWordKeys"]);
    prefs.sourceLang = validLang(stored?.sourceLang) || "en";
    prefs.targetLang = validLang(stored?.targetLang) || "pt";
    // Migração: background é o único escritor de savedWordKeys
    if (!Array.isArray(stored?.savedWordKeys)) writeSavedWordKeys(stored?.savedWords);
  } catch { }
}

const prefsReady = loadPrefs();

// ── Cache de fonética (chrome.storage.local, mapa limitado) ──
async function restorePhoneticCache() {
  try {
    const stored = await chrome.storage.local.get("phoneticCache");
    const entries = stored?.phoneticCache;
    if (!Array.isArray(entries)) return;
    const now = Date.now();
    for (const [k, v] of entries) {
      if (v && v.expires > now && !phoneticCache.has(k)) phoneticCache.set(k, v);
    }
  } catch { }
}

const phoneticReady = restorePhoneticCache();
let phoneticPersistTimer = null;

function persistPhoneticCache() {
  if (phoneticPersistTimer) return;
  phoneticPersistTimer = setTimeout(() => {
    phoneticPersistTimer = null;
    phoneticReady.then(() => {
      try {
        chrome.storage.local.set({ phoneticCache: [...phoneticCache.entries()] })?.catch?.(() => { });
      } catch { }
    });
  }, PHONETIC_PERSIST_DELAY_MS);
}

function contextMenuTitle(lang) {
  return (UI_STRINGS[lang] || UI_STRINGS.pt).contextMenuTitle;
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.get("uiLang", ({ uiLang }) => {
    chrome.contextMenus.create({
      id: "tradupop-translate",
      title: contextMenuTitle(uiLang),
      contexts: ["selection"],
    });
  });
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.sourceLang) prefs.sourceLang = validLang(changes.sourceLang.newValue) || "en";
  if (changes.targetLang) prefs.targetLang = validLang(changes.targetLang.newValue) || "pt";
  if (changes.savedWords) writeSavedWordKeys(changes.savedWords.newValue);
  if (changes.uiLang) {
    const title = contextMenuTitle(changes.uiLang.newValue);
    chrome.contextMenus.update("tradupop-translate", { title }, () => {
      if (chrome.runtime.lastError) {
        chrome.contextMenus.create({
          id: "tradupop-translate",
          title,
          contexts: ["selection"],
        });
      }
    });
  }
  // Ao sair do modo ícone, limpa aviso e seleção pendente
  if (changes.popupMode && changes.popupMode.newValue !== "icon") {
    chrome.action.setBadgeText({ text: "" });
    try { chrome.storage.session.remove("pendingSelection"); } catch { }
  }
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== "tradupop-translate" || !tab?.id) return;
  chrome.tabs.sendMessage(tab.id, {
    type: "TRANSLATE_SELECTION",
    text: info.selectionText,
  });
});

// ── Modo ícone: a tradução abre no popup da ação em vez de na página ──
// A seleção pendente vive em storage.session para sobreviver à suspensão do SW.
const PENDING_SELECTION_TTL_MS = 2 * 60 * 1000;

// Garante uma única chamada de sendResponse, mesmo se o handler lançar
function respondAsync(sendResponse, handler, fallback) {
  let done = false;
  const reply = (value) => {
    if (done) return;
    done = true;
    try { sendResponse(value); } catch { }
  };
  Promise.resolve()
    .then(() => handler(reply))
    .then((value) => { if (value !== undefined) reply(value); })
    .catch((error) => reply(fallback(error)));
  return true;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  try {
    switch (message?.type) {
      case "TRANSLATE_TEXT":
        return respondAsync(sendResponse, () => handleTranslate(message, sender), (error) => ({
          ok: false,
          error: error?.message || "Erro na tradução."
        }));

      case "GET_PHONETIC":
        return respondAsync(sendResponse, async () => ({
          phonetic: await getPhonetic(message.text, message.sl)
        }), () => ({ phonetic: "" }));

      case "WARM":
        // Sem resposta por contrato
        warmUp();
        return;

      case "OPEN_ACTION_POPUP":
        return respondAsync(sendResponse, (reply) => openActionPopup(message, reply), () => ({ ok: false }));

      case "GET_PENDING_SELECTION":
        return respondAsync(sendResponse, getPendingSelection, () => ({ pending: null }));

      default:
        return;
    }
  } catch (error) {
    console.warn("[TradupPop] Falha ao processar mensagem:", error?.message);
    try { sendResponse({ ok: false, error: error?.message || "Erro interno." }); } catch { }
  }
});

function openActionPopup(message, reply) {
  const text = (message.text || "").trim();
  if (!text) return { ok: false };
  const pending = { text, context: message.context || "", ts: Date.now() };
  try { chrome.storage.session.set({ pendingSelection: pending }); } catch { }

  const showBadge = () => {
    chrome.action.setBadgeBackgroundColor({ color: "#2563EB" });
    chrome.action.setBadgeText({ text: "1" });
    reply({ ok: false });
  };

  // openPopup existe a partir do Chrome 127; falha se a janela não tiver foco
  if (chrome.action.openPopup) {
    chrome.action.openPopup()
      .then(() => reply({ ok: true }))
      .catch(showBadge);
  } else {
    showBadge();
  }
  return undefined;
}

async function getPendingSelection() {
  chrome.action.setBadgeText({ text: "" });
  const stored = await chrome.storage.session.get("pendingSelection");
  const pending = stored?.pendingSelection;
  const fresh = pending && Date.now() - pending.ts <= PENDING_SELECTION_TTL_MS;
  chrome.storage.session.remove("pendingSelection")?.catch?.(() => { });
  return { pending: fresh ? pending : null };
}

// ── Tradução ──
async function handleTranslate(message, sender) {
  const text = String(message.text || "").trim().slice(0, MAX_TEXT_LENGTH).trim();
  if (!text) {
    return { ok: false, error: "Texto vazio." };
  }

  await prefsReady;
  // sl/tl da mensagem têm precedência quando válidos
  const sl = validLang(message.sl) || prefs.sourceLang;
  const tl = validLang(message.tl) || prefs.targetLang;
  const slotKey = message.slot
    ? `${sender?.tab?.id ?? "ext"}:${sender?.frameId ?? 0}:${message.slot}`
    : null;

  const result = await translate(text, sl, tl, slotKey);
  if (result === CANCELLED_ERROR) {
    return { ok: false, error: CANCELLED_ERROR, cancelled: true };
  }
  return { ok: true, ...result };
}

async function translate(text, sl = "en", tl = "pt", slotKey = null) {
  // Valida códigos de idioma antes de qualquer uso em URLs
  if (!LANG_CODE_RE.test(sl) || !LANG_CODE_RE.test(tl)) {
    throw new Error("Código de idioma inválido.");
  }

  // A requisição anterior do mesmo remetente+slot fica obsoleta.
  // Registro síncrono (antes de qualquer await) para não perder a ordem.
  let ticket = null;
  let isCancelled = false;
  let cancel;
  const cancelled = new Promise((resolve) => { cancel = resolve; });
  const slotEntry = {
    cancel: () => {
      isCancelled = true;
      cancel(CANCELLED_ERROR);
      ticket?.release();
    }
  };
  if (slotKey) {
    slots.get(slotKey)?.cancel();
    slots.set(slotKey, slotEntry);
  }

  try {
    await cacheReady;
    if (isCancelled) return CANCELLED_ERROR;

    const cacheKey = normalizeCacheKey(text, sl, tl);
    const cached = getFromCache(cacheKey);
    if (cached) return withPhoneticState(cached, text, sl);

    const failure = getCachedError(cacheKey);
    if (failure) throw new Error(failure);

    ticket = acquireTranslation(cacheKey, text, sl, tl);
    const result = await Promise.race([ticket.promise, cancelled]);
    if (result === CANCELLED_ERROR) return CANCELLED_ERROR;
    return withPhoneticState(result, text, sl);
  } catch (error) {
    if (error?.cancelled) return CANCELLED_ERROR;
    throw error;
  } finally {
    if (slotKey && slots.get(slotKey) === slotEntry) slots.delete(slotKey);
    ticket?.release();
  }
}

// Dedup: requisições iguais compartilham a mesma busca (refcount de interessados).
// A rede só é abortada quando não sobra nenhum interessado.
function acquireTranslation(key, text, sl, tl) {
  let flight = inFlight.get(key);
  if (!flight) {
    const controller = new AbortController();
    flight = { controller, waiters: 0, promise: null };
    const current = flight;
    current.promise = runProviders(key, text, sl, tl, controller.signal).finally(() => {
      if (inFlight.get(key) === current) inFlight.delete(key);
    });
    // Evita unhandled rejection quando todos os interessados cancelaram
    current.promise.catch(() => { });
    inFlight.set(key, current);
  }

  const current = flight;
  current.waiters += 1;
  let released = false;
  return {
    promise: current.promise,
    release: () => {
      if (released) return;
      released = true;
      current.waiters -= 1;
      if (current.waiters <= 0 && inFlight.get(key) === current) {
        inFlight.delete(key);
        current.controller.abort();
      }
    }
  };
}

async function runProviders(cacheKey, text, sl, tl, signal) {
  // Fonética em paralelo, fora do caminho crítico
  const phoneticWord = wantsPhonetic(text, sl) ? text.toLowerCase() : "";
  if (phoneticWord) ensurePhonetic(phoneticWord);

  try {
    const value = await hedgedTranslate(text, sl, tl, signal);
    if (!value.phonetic && phoneticWord) {
      const known = getPhoneticCached(phoneticWord);
      if (known) value.phonetic = known;
    }
    const ttl = value.source === "mymemory" ? MYMEMORY_CACHE_TTL_MS : CACHE_TTL_MS;
    setInCache(cacheKey, value, ttl, phoneticWord);
    return value;
  } catch (error) {
    if (!signal.aborted && !error?.cancelled) {
      setCachedError(cacheKey, error?.message || "Erro na tradução.");
    }
    throw error;
  }
}

function hedgedTranslate(text, sl, tl, signal) {
  return new Promise((resolve, reject) => {
    const googleCtl = new AbortController();
    const memoryCtl = new AbortController();
    let settled = false;
    let googleFailed = false;
    let googleError = null;
    let memoryStarted = false;
    let memoryResult = null;
    let memoryError = null;
    let hedgeTimer = null;
    let graceTimer = null;

    const onAbort = () => {
      googleCtl.abort();
      memoryCtl.abort();
      finish(reject, cancelledError());
    };

    function finish(fn, value) {
      if (settled) return;
      settled = true;
      clearTimeout(hedgeTimer);
      clearTimeout(graceTimer);
      signal?.removeEventListener?.("abort", onAbort);
      fn(value);
    }

    if (signal?.aborted) {
      finish(reject, cancelledError());
      return;
    }
    signal?.addEventListener?.("abort", onAbort, { once: true });

    const startMyMemory = () => {
      if (memoryStarted || settled) return;
      memoryStarted = true;
      translateWithMyMemory(text, sl, tl, memoryCtl.signal).then((result) => {
        memoryResult = { ...result, source: "mymemory" };
        if (googleFailed) {
          finish(resolve, memoryResult);
          return;
        }
        // Google ainda pendente: curta tolerância antes de aceitar o MyMemory
        graceTimer = setTimeout(() => {
          googleCtl.abort();
          finish(resolve, memoryResult);
        }, GOOGLE_GRACE_MS);
      }, (error) => {
        memoryError = error;
        if (googleFailed) finish(reject, error || googleError);
      });
    };

    if (Date.now() < googleDownUntil) {
      googleFailed = true;
      startMyMemory();
      return;
    }

    hedgeTimer = setTimeout(startMyMemory, HEDGE_DELAY_MS);

    translateWithGoogle(text, sl, tl, googleCtl.signal).then((result) => {
      memoryCtl.abort();
      finish(resolve, { ...result, source: "google" });
    }, (error) => {
      if (settled) return;
      console.warn("[TradupPop] Google Translate falhou, usando fallback:", error?.message);
      googleFailed = true;
      googleError = error;
      if (error?.breaker !== false) googleDownUntil = Date.now() + GOOGLE_DOWN_MS;
      clearTimeout(hedgeTimer);
      if (memoryResult) {
        finish(resolve, memoryResult);
      } else if (memoryError) {
        finish(reject, memoryError);
      } else {
        startMyMemory();
      }
    });
  });
}

function cancelledError() {
  const error = new Error(CANCELLED_ERROR);
  error.cancelled = true;
  return error;
}

// Timeout cobre fetch E leitura do corpo; aceita AbortSignal externo (init.signal).
async function fetchJson(url, ms, init = {}) {
  const controller = new AbortController();
  const external = init.signal;
  const onExternalAbort = () => controller.abort();
  if (external) {
    if (external.aborted) controller.abort();
    else external.addEventListener("abort", onExternalAbort, { once: true });
  }
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, ms);

  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    if (!response.ok) {
      const error = new Error(`HTTP ${response.status}`);
      error.status = response.status;
      throw error;
    }
    return await response.json();
  } catch (error) {
    if (external?.aborted) throw cancelledError();
    if (timedOut) throw new Error("Tempo esgotado ao traduzir.");
    throw error;
  } finally {
    clearTimeout(timer);
    external?.removeEventListener("abort", onExternalAbort);
  }
}

async function translateWithGoogle(text, sl = "en", tl = "pt", signal) {
  const isSingleWord = isSingleEnglishWord(text);
  const url = new URL("https://translate.googleapis.com/translate_a/single");
  url.searchParams.set("client", "gtx");
  url.searchParams.set("sl", sl);
  url.searchParams.set("tl", tl);
  url.searchParams.append("dt", "t");
  url.searchParams.append("dt", "rm");
  // Dicionário, definições e exemplos só fazem sentido para palavra única
  if (isSingleWord) {
    url.searchParams.append("dt", "bd");
    url.searchParams.append("dt", "md");
    url.searchParams.append("dt", "ex");
  }
  url.searchParams.set("q", text);

  lastGoogleRequestAt = Date.now();
  let data;
  try {
    data = await fetchJson(url.toString(), GOOGLE_TIMEOUT_MS, { signal });
  } catch (error) {
    if (error?.status) throw new Error(`Google Translate indisponível (${error.status}).`);
    throw error;
  }

  const segments = Array.isArray(data?.[0]) ? data[0] : [];
  const translated = segments.map((s) => s?.[0] || "").join("").trim();

  if (!translated) {
    const error = new Error("Google Translate sem resultado.");
    // Resposta vazia não indica serviço fora do ar
    error.breaker = false;
    throw error;
  }

  const alternatives = isSingleWord
    ? extractAlternativeTranslations(data, translated, text)
    : [];
  const dictionary = isSingleWord
    ? extractDictionaryEntries(data, text)
    : [];
  const examples = isSingleWord ? extractExamples(data) : [];
  const definitions = isSingleWord ? extractDefinitions(data) : [];
  const phonetic = extractPhonetic(data);

  return { translated, alternatives, dictionary, examples, definitions, phonetic };
}

async function translateWithMyMemory(text, sl = "en", tl = "pt", signal) {
  const url = new URL("https://api.mymemory.translated.net/get");
  url.searchParams.set("q", text);
  url.searchParams.set("langpair", `${sl}|${tl}`);

  let data;
  try {
    data = await fetchJson(url.toString(), MYMEMORY_TIMEOUT_MS, { signal });
  } catch (error) {
    if (error?.status) throw new Error(`Serviço alternativo indisponível (${error.status}).`);
    throw error;
  }

  // MyMemory responde HTTP 200 mesmo com erro de cota; o status real vem no corpo
  if (String(data?.responseStatus) !== "200") {
    throw new Error("Serviço alternativo indisponível. Tente novamente.");
  }

  const translated = (data?.responseData?.translatedText || "").trim();

  if (!translated || /^MYMEMORY WARNING/i.test(translated)) {
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
    definitions: [],
    phonetic: ""
  };
}

// ── Fonética (dictionaryapi.dev) ──
function wantsPhonetic(text, sl) {
  return sl === "en" && isSingleEnglishWord(text);
}

function phoneticKey(word) {
  return `ph:${word}`;
}

// Retorna string (possivelmente vazia) se houver no cache, ou null
function getPhoneticCached(word) {
  const key = phoneticKey(word);
  const entry = phoneticCache.get(key);
  if (!entry) return null;
  if (entry.expires <= Date.now()) {
    phoneticCache.delete(key);
    return null;
  }
  return entry.phonetic;
}

function setPhoneticCached(word, phonetic, ttl) {
  const key = phoneticKey(word);
  phoneticCache.delete(key);
  if (phoneticCache.size >= PHONETIC_MAX_ITEMS) {
    const oldestKey = phoneticCache.keys().next().value;
    if (oldestKey) phoneticCache.delete(oldestKey);
  }
  phoneticCache.set(key, { phonetic, expires: Date.now() + ttl });
  persistPhoneticCache();
}

function ensurePhonetic(word) {
  if (getPhoneticCached(word) !== null) return Promise.resolve(getPhoneticCached(word));
  const running = phoneticInFlight.get(word);
  if (running) return running;

  const promise = (async () => {
    await phoneticReady;
    const known = getPhoneticCached(word);
    if (known !== null) return known;

    let phonetic = "";
    let ttl = PHONETIC_TTL_MS;
    try {
      const data = await fetchJson(
        `https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(word)}`,
        PHONETIC_TIMEOUT_MS
      );
      const phonetics = data?.[0]?.phonetics || [];
      const found = phonetics.find((p) => p?.text && p.text.trim());
      phonetic = found ? found.text.trim() : "";
    } catch (error) {
      // 404 = palavra inexistente (definitivo); timeout/rede = negativo curto
      if (error?.status !== 404) ttl = PHONETIC_NEGATIVE_TTL_MS;
    }

    setPhoneticCached(word, phonetic, ttl);
    if (phonetic) applyPhoneticToCache(word, phonetic);
    return phonetic;
  })().catch(() => "").finally(() => {
    phoneticInFlight.delete(word);
  });

  phoneticInFlight.set(word, promise);
  return promise;
}

// Atualiza traduções em cache para que os próximos hits já venham com fonética
function applyPhoneticToCache(word, phonetic) {
  for (const [key, entry] of translationCache) {
    if (entry.ph !== word || entry.value?.phonetic) continue;
    entry.value = { ...entry.value, phonetic };
    persistEntry(key, entry);
  }
}

function withPhoneticState(result, text, sl) {
  const out = { ...result, phoneticPending: false };
  if (out.phonetic || !wantsPhonetic(text, sl)) return out;

  const word = text.toLowerCase();
  const known = getPhoneticCached(word);
  if (known !== null) {
    out.phonetic = known;
    return out;
  }
  ensurePhonetic(word);
  out.phoneticPending = true;
  return out;
}

async function getPhonetic(rawText, rawSl) {
  const text = String(rawText || "").trim().slice(0, MAX_TEXT_LENGTH).trim();
  await prefsReady;
  const sl = validLang(rawSl) || prefs.sourceLang;
  if (!text || !wantsPhonetic(text, sl)) return "";

  const word = text.toLowerCase();
  await phoneticReady;
  const known = getPhoneticCached(word);
  if (known !== null) return known;

  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(""), PHONETIC_WAIT_MS);
  });
  try {
    return await Promise.race([ensurePhonetic(word), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

// ── Pré-aquecimento da conexão com o Google (TLS/DNS) ──
function warmUp() {
  const now = Date.now();
  if (now < googleDownUntil) return;
  if (now - lastGoogleRequestAt < WARM_INTERVAL_MS || now - lastWarmAt < WARM_INTERVAL_MS) return;
  lastWarmAt = now;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), WARM_TIMEOUT_MS);
    fetch("https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=pt&dt=t&q=a", {
      method: "HEAD",
      signal: controller.signal
    }).catch(() => { }).finally(() => clearTimeout(timer));
  } catch { }
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

// Definições monolíngues do bloco dt=md: data[12] = [[pos, [[definição, ...], ...], palavra], ...]
// O shape não é documentado e pode mudar — extração 100% defensiva, nunca lança.
function extractDefinitions(data) {
  try {
    const blocks = Array.isArray(data?.[12]) ? data[12] : [];
    const groups = [];
    let total = 0;

    for (const block of blocks) {
      if (total >= 2) break;
      if (!Array.isArray(block)) continue;
      const pos = typeof block[0] === "string" ? block[0].trim() : "";
      const rawDefs = Array.isArray(block[1]) ? block[1] : [];
      const defs = [];

      for (const def of rawDefs) {
        const text = Array.isArray(def) && typeof def[0] === "string" ? def[0].trim() : "";
        if (!text || text.length < 5 || text.length > 300) continue;
        defs.push(text);
        total += 1;
        if (defs.length >= 2 || total >= 2) break;
      }

      if (defs.length > 0) groups.push({ pos, defs });
    }

    return groups;
  } catch {
    return [];
  }
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

// Palavra única vira minúscula, exceto TUDO MAIÚSCULO (ex: "US" ≠ "us")
function normalizeCacheKey(text, sl = "en", tl = "pt") {
  const value = (text || "").trim();
  const lower = isSingleEnglishWord(value) && value !== value.toUpperCase();
  return `${CACHE_SCHEMA_VERSION}:${sl}:${tl}:${lower ? value.toLowerCase() : value}`;
}

function getFromCache(key) {
  const entry = translationCache.get(key);
  if (!entry) return null;

  if (Date.now() - entry.timestamp > (entry.ttl || CACHE_TTL_MS)) {
    translationCache.delete(key);
    unpersistEntries([key]);
    return null;
  }

  // LRU real: reinsere para marcar como mais recente
  translationCache.delete(key);
  translationCache.set(key, entry);
  return entry.value;
}

function setInCache(key, value, ttl = CACHE_TTL_MS, ph = "") {
  if (!key) return;

  const evicted = [];
  translationCache.delete(key);
  while (translationCache.size >= CACHE_MAX_ITEMS) {
    const oldestKey = translationCache.keys().next().value;
    if (oldestKey === undefined) break;
    translationCache.delete(oldestKey);
    evicted.push(oldestKey);
  }

  const entry = { value, timestamp: Date.now(), ttl, ph };
  translationCache.set(key, entry);
  errorCache.delete(key);
  unpersistEntries(evicted);
  persistEntry(key, entry);
}

// Cache negativo curto: seleções repetidas falham rápido quando tudo está fora
function getCachedError(key) {
  const entry = errorCache.get(key);
  if (!entry) return null;
  if (entry.expires <= Date.now()) {
    errorCache.delete(key);
    return null;
  }
  return entry.error;
}

function setCachedError(key, error) {
  errorCache.delete(key);
  if (errorCache.size >= ERROR_CACHE_MAX_ITEMS) {
    const oldestKey = errorCache.keys().next().value;
    if (oldestKey !== undefined) errorCache.delete(oldestKey);
  }
  errorCache.set(key, { error, expires: Date.now() + ERROR_CACHE_TTL_MS });
}
