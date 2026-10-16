// Estado do popup (shadow DOM criado sob demanda no primeiro show)
let hostEl = null;
let shadow = null;
let popupEl = null;
let ui = null;             // refs dos elementos fixos do popup
let popupShown = false;
let hideTimer = null;
let sessionId = 0;
let stylesReady = false;
let stylesWaiters = [];
let labelsKey = "";

let savedKeys = new Set(); // word.toLowerCase() — espelho de savedWordKeys
let savedKeysLoaded = false;
let savedKeysWaiters = null;

let historyStack = [];
let currentState = null;
let activeTranslation = "";
let lastQueryText = null;
let lastSelection = null;  // { text, range, context } — contexto calculado só ao salvar
let lastSelKey = null;     // anchor/focus da última seleção tratada

let shortcutKey = "q";
let darkModeEnabled = false;
let darkModeExplicit = false; // usuário setou darkMode manualmente; senão segue o sistema
let sourceLang = "en";
let targetLang = "pt";
let uiLang = "pt";
let pinnedPosition = null; // { top, left } quando fixado
let popupMode = "page"; // "page" (popup in-page) | "icon" (popup da ação, abaixo do ícone)
let settingsLoaded = false;
let settingsWaiters = null;

let draggingPopup = false; // arraste do popup em andamento (suprime handleSelection no mouseup)
let isDragged = false;

const IS_TOP = window === window.top;
const HISTORY_MAX = 20;
const CONTEXT_RADIUS = 300;
const SEL_RAW_MAX = 3000; // limite barato antes de serializar a seleção
const SEL_NODES_MAX = 300;
const DONATION_CONFIGURED = typeof DONATION !== "undefined" && !!(DONATION.url || DONATION.pixKey);

function t(key) {
  return (UI_STRINGS[uiLang] || UI_STRINGS["pt"])[key] || key;
}

// LANG_TTS e LANG_NAMES são globais definidos em ui-strings.js

// ── Configurações ──
// Frame principal carrega já; iframes só na primeira interação (anúncios etc. nunca pagam o custo)

const SETTINGS_KEYS = ["shortcutKey", "darkMode", "sourceLang", "targetLang", "uiLang", "pinnedPosition", "popupMode"];

function loadSettings(callback) {
  if (settingsLoaded) { if (callback) callback(); return; }
  if (settingsWaiters) { if (callback) settingsWaiters.push(callback); return; }
  settingsWaiters = callback ? [callback] : [];
  const done = (result) => {
    if (result.popupMode) popupMode = result.popupMode;
    if (result.shortcutKey) shortcutKey = result.shortcutKey.toLowerCase();
    darkModeEnabled = resolveDarkMode(result.darkMode);
    darkModeExplicit = result.darkMode !== undefined;
    if (result.sourceLang) sourceLang = result.sourceLang;
    if (result.targetLang) targetLang = result.targetLang;
    if (result.uiLang) uiLang = result.uiLang;
    if (result.pinnedPosition) pinnedPosition = result.pinnedPosition;
    settingsLoaded = true;
    const waiters = settingsWaiters;
    settingsWaiters = null;
    waiters.forEach((fn) => fn());
  };
  try {
    chrome.storage.local.get(SETTINGS_KEYS, (result) => done(result || {}));
  } catch {
    done({}); // contexto da extensão invalidado
  }
}

if (IS_TOP) loadSettings();

// Reage a mudanças em tempo real (só atualiza variáveis; nada pesado aqui)
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.savedWordKeys) {
    const list = changes.savedWordKeys.newValue;
    savedKeys = toKeySet(list);
    savedKeysLoaded = true;
    if (popupShown && currentState) setSaved(savedKeys.has(currentState.sourceText.toLowerCase()));
  }
  if (changes.shortcutKey) shortcutKey = (changes.shortcutKey.newValue || "q").toLowerCase();
  if (changes.darkMode) {
    darkModeExplicit = changes.darkMode.newValue !== undefined;
    darkModeEnabled = resolveDarkMode(changes.darkMode.newValue);
    if (popupEl) popupEl.classList.toggle("dark-mode", darkModeEnabled);
  }
  if (changes.sourceLang) sourceLang = changes.sourceLang.newValue || "en";
  if (changes.targetLang) targetLang = changes.targetLang.newValue || "pt";
  if (changes.uiLang) uiLang = changes.uiLang.newValue || "pt";
  if (changes.popupMode) popupMode = changes.popupMode.newValue || "page";
  if (changes.pinnedPosition) {
    pinnedPosition = changes.pinnedPosition.newValue || null;
    if (ui) ui.pinBtn.classList.toggle("is-pinned", !!pinnedPosition);
    // Desafixado em outra aba: converte coords antes de tirar o fixed,
    // senão o popup salta para fora da tela
    if (!pinnedPosition && popupEl && popupEl.classList.contains("is-pinned")) {
      const bcrect = popupEl.getBoundingClientRect();
      popupEl.classList.remove("is-pinned");
      popupEl.style.top  = `${bcrect.top + window.scrollY}px`;
      popupEl.style.left = `${bcrect.left + window.scrollX}px`;
      isDragged = false;
    }
  }
});

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type !== "TRANSLATE_SELECTION") return;
  const text = (message.text || "").trim();
  if (!text) return;
  loadSettings(() => translateFromMessage(text));
});

function translateFromMessage(text) {
  const sel = window.getSelection();
  let rect = null;
  let range = null;
  if (sel && sel.rangeCount > 0) {
    range = sel.getRangeAt(0);
    const r = range.getBoundingClientRect();
    if (r && (r.width > 0 || r.height > 0)) rect = r;
  }
  lastSelKey = null;
  lastSelection = { text, range: range ? range.cloneRange() : null, context: null };
  if (popupMode === "icon") {
    sendToActionPopup(text);
    return;
  }
  openSession(rect);
  if (!chrome?.runtime?.id) {
    lastQueryText = text;
    renderLoading(text, false);
    renderError();
    return;
  }
  requestMain(text, false);
}

document.addEventListener("mouseup", handleSelection);
document.addEventListener("keydown", (event) => {
  if (event.ctrlKey && event.key && event.key.toLowerCase() === shortcutKey) {
    const text = window.getSelection()?.toString().trim();
    if (text) {
      event.preventDefault();
      speakText(text, LANG_TTS[sourceLang] || "en-US");
    }
  }
});
document.addEventListener("keyup", (event) => {
  if (event.key === "Escape" && popupShown) {
    hidePopup();
  }
});
// Adia o hide para dar chance ao mouseup registrar nova seleção
let pendingHide = null;
document.addEventListener("mousedown", (event) => {
  warmUp();
  // Eventos vindos do shadow DOM chegam aqui retargetados para o host
  if (popupShown && event.target !== hostEl) {
    pendingHide = setTimeout(() => { pendingHide = null; hidePopup(); }, 0);
  }
});
document.addEventListener("selectstart", warmUp);

// Acorda o service worker antes do mouseup (throttle de 5s)
let lastWarm = 0;
function warmUp() {
  if (isTinyFrame()) return;
  if (!settingsLoaded) loadSettings();
  const now = Date.now();
  if (now - lastWarm < 5000) return;
  lastWarm = now;
  if (!chrome?.runtime?.id) return;
  try {
    chrome.runtime.sendMessage({ type: "WARM" }, () => { void chrome.runtime.lastError; });
  } catch { /* contexto invalidado */ }
}

function isTinyFrame() {
  return !IS_TOP && (window.innerWidth < 300 || window.innerHeight < 200);
}

function handleSelection(event) {
  // Soltar um arraste do popup fora dele não deve re-disparar a tradução
  if (draggingPopup) return;
  if (hostEl && event?.target === hostEl) return;
  if (isTinyFrame()) return;

  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return;

  if (!settingsLoaded) {
    loadSettings(() => handleSelection(event));
    return;
  }

  // Mesma seleção já exibida (ex: mouseup após scrollbar): nada a fazer
  if (popupShown && lastSelKey &&
      lastSelKey.an === selection.anchorNode && lastSelKey.ao === selection.anchorOffset &&
      lastSelKey.fn === selection.focusNode  && lastSelKey.fo === selection.focusOffset) {
    return;
  }

  const range = selection.getRangeAt(0);
  if (rangeTooLarge(range)) {
    hidePopup();
    return;
  }

  const text = selection.toString().trim();
  if (!text || text.length > 500) {
    hidePopup();
    return;
  }

  if (!looksLikeEnglish(text)) {
    hidePopup();
    return;
  }

  const rect = range.getBoundingClientRect();
  if (!rect || (rect.width === 0 && rect.height === 0)) {
    return;
  }

  if (pendingHide) { clearTimeout(pendingHide); pendingHide = null; }
  lastSelKey = { an: selection.anchorNode, ao: selection.anchorOffset, fn: selection.focusNode, fo: selection.focusOffset };
  lastSelection = { text, range: range.cloneRange(), context: null };

  if (popupMode === "icon") {
    sendToActionPopup(text);
    return;
  }

  openSession(rect);

  if (!chrome?.runtime?.id) {
    lastQueryText = text;
    renderLoading(text, false);
    renderError();
    return;
  }

  requestMain(text, false);
}

// Conta texto da seleção sem serializá-la (Ctrl+A em página enorme etc.)
function rangeTooLarge(range) {
  const sc = range.startContainer;
  if (sc === range.endContainer && sc.nodeType === 3) {
    return range.endOffset - range.startOffset > SEL_RAW_MAX;
  }
  const walker = document.createTreeWalker(range.commonAncestorContainer, NodeFilter.SHOW_TEXT);
  let n;
  if (sc.nodeType === 3) {
    walker.currentNode = sc;
    n = sc;
  } else {
    const child = sc.childNodes[range.startOffset];
    walker.currentNode = child || lastDescendant(sc);
    n = child && child.nodeType === 3 ? child : walker.nextNode();
  }
  let chars = 0;
  let nodes = 0;
  while (n) {
    if (n !== sc && range.comparePoint(n, 0) > 0) break; // passou do fim
    chars += n.length;
    if (chars > SEL_RAW_MAX || ++nodes > SEL_NODES_MAX) return true;
    n = walker.nextNode();
  }
  return false;
}

// Modo ícone: entrega a seleção ao background, que abre o popup da ação
function sendToActionPopup(text) {
  if (!chrome?.runtime?.id) return;
  try {
    chrome.runtime.sendMessage({
      type: "OPEN_ACTION_POPUP",
      text,
      context: getLastContext(),
    }, () => {
      // Ignora erros (ex: SW reiniciando); o badge no ícone cobre o fallback
      void chrome.runtime.lastError;
    });
  } catch { /* contexto invalidado */ }
}

// ── Requisições ──

// Descarta respostas obsoletas quando o usuário dispara traduções em sequência
let translateSeq = 0;

function sendTranslate(text, slot, callback) {
  try {
    chrome.runtime.sendMessage({ type: "TRANSLATE_TEXT", text, sl: sourceLang, tl: targetLang, slot }, (response) => {
      if (chrome.runtime.lastError) { callback(null); return; }
      callback(response);
    });
  } catch {
    callback(null);
  }
}

// refresh=true (sinônimo clicado): mantém o conteúdo atual esmaecido
function requestMain(text, refresh) {
  lastQueryText = text;
  const seq = ++translateSeq;
  renderLoading(text, refresh);
  sendTranslate(text, "main", (response) => {
    if (seq !== translateSeq) return;
    if (response?.cancelled) return;
    if (!response?.ok) {
      renderError();
      return;
    }
    const state = {
      translatedText: response.translated,
      sourceText: text,
      alternatives: response.alternatives || [],
      dictionary: response.dictionary || [],
      examples: response.examples || [],
      phonetic: response.phonetic || "",
      definitions: response.definitions || [],
    };
    renderResult(state);
    preloadAudio(text, LANG_TTS[sourceLang] || "en-US");
    if (response.phoneticPending && !state.phonetic) fetchPhonetic(state);
  });
}

// Fonética chega depois: preenche no lugar se o resultado ainda está na tela
function fetchPhonetic(state) {
  try {
    chrome.runtime.sendMessage({ type: "GET_PHONETIC", text: state.sourceText, sl: sourceLang }, (response) => {
      if (chrome.runtime.lastError) return;
      const phonetic = response?.phonetic;
      if (!phonetic) return;
      state.phonetic = phonetic; // histórico e "salvar" passam a ter a fonética
      if (popupShown && currentState === state) {
        setPhonetic(phonetic);
        afterRender();
      }
    });
  } catch { /* contexto invalidado */ }
}

function retranslate(word) {
  if (!word) return;
  if (currentState) {
    historyStack.push(currentState);
    if (historyStack.length > HISTORY_MAX) historyStack.shift();
  }
  requestMain(word, true);
}

function goBack() {
  const prev = historyStack.pop();
  if (prev) {
    ++translateSeq; // descarta tradução em andamento
    lastQueryText = prev.sourceText;
    renderResult(prev);
  }
}

// ── Popup: estrutura criada uma vez, conteúdo atualizado no lugar ──

function ensurePopup() {
  if (popupEl) {
    if (!hostEl.isConnected) document.documentElement.appendChild(hostEl);
    return;
  }

  hostEl = document.createElement("tradupop-root");
  setHostStyle(false);
  shadow = hostEl.attachShadow({ mode: "closed" });

  // CSS dentro do shadow; host fica invisível até carregar (evita FOUC)
  const cssUrl = chrome.runtime.getURL("styles.css");
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = cssUrl;
  link.addEventListener("load", markStylesReady, { once: true });
  link.addEventListener("error", () => {
    // CSP da página bloqueou o <link>: tenta inline
    fetch(cssUrl).then((r) => r.text()).then((css) => {
      const style = document.createElement("style");
      style.textContent = css;
      shadow.appendChild(style);
    }).catch(() => {}).finally(markStylesReady);
  }, { once: true });
  setTimeout(markStylesReady, 1500);
  shadow.appendChild(link);

  popupEl = document.createElement("div");
  popupEl.className = "translate-selection-popup";
  popupEl.setAttribute("role", "dialog");
  popupEl.innerHTML = popupSkeleton();
  shadow.appendChild(popupEl);

  ui = {};
  for (const el of popupEl.querySelectorAll("[data-ref]")) ui[el.dataset.ref] = el;
  if (ui.pixKey) ui.pixKey.textContent = DONATION.pixKey;

  // Delegação: um listener por tipo de evento para todo o popup
  popupEl.addEventListener("mousedown", onPopupMouseDown);
  popupEl.addEventListener("mouseup", onPopupMouseUp);
  popupEl.addEventListener("click", onPopupClick);

  document.documentElement.appendChild(hostEl);

  // Segue o tema do sistema enquanto o usuário não escolher manualmente
  if (window.matchMedia) {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    if (!darkModeExplicit) darkModeEnabled = mq.matches;
    mq.addEventListener("change", (event) => {
      if (darkModeExplicit) return;
      darkModeEnabled = event.matches;
      popupEl.classList.toggle("dark-mode", darkModeEnabled);
    });
  }
}

function setHostStyle(visible) {
  hostEl.setAttribute("style",
    "all: initial !important; position: absolute !important; top: 0 !important; left: 0 !important;" +
    "width: 0 !important; height: 0 !important; overflow: visible !important; z-index: 2147483647 !important;" +
    (visible ? "" : "visibility: hidden !important;"));
}

function markStylesReady() {
  if (stylesReady) return;
  stylesReady = true;
  setHostStyle(true);
  const waiters = stylesWaiters;
  stylesWaiters = [];
  waiters.forEach((fn) => fn());
}

function whenStylesReady(fn) {
  if (stylesReady) fn();
  else stylesWaiters.push(fn);
}

function popupSkeleton() {
  const support = DONATION_CONFIGURED ? `
    <div class="translate-support-card" data-ref="supportCard">
      <div class="translate-support-msg" data-i18n="supportHint"></div>
      ${DONATION.pixKey ? `
      <div class="translate-support-pix-label" data-i18n="pixKeyLabel"></div>
      <code class="translate-support-pix-key" data-ref="pixKey"></code>
      <button type="button" class="translate-support-copy" data-action="copy-pix" data-i18n="copyPix"></button>
      <div class="translate-support-feedback" role="status" aria-live="polite" data-ref="supportFeedback"></div>` : ""}
      ${DONATION.url ? `
      <button type="button" class="translate-support-donate" data-action="donate">☕ <span data-i18n="donateBtn"></span></button>` : ""}
    </div>` : "";
  const heart = DONATION_CONFIGURED ? `
      <button type="button" class="translate-heart-btn" data-action="support" data-ref="heartBtn" data-i18n-label="supportTitle">${ICON_SVG.heart}<span data-i18n="supportProject"></span></button>` : "";

  return `
    <div class="translate-header" data-ref="header">
      <div class="translate-title-wrap">
        <button type="button" class="translate-back-btn" data-action="back" data-ref="backBtn" data-i18n-label="back" hidden>${ICON_SVG.back} <span data-i18n="back"></span></button>
        <span class="translate-source-lang-tag" data-ref="srcLang"></span>
        <div class="translate-source" data-ref="source"></div>
        <div class="translate-source-phonetic" data-ref="phonetic" hidden></div>
      </div>
      <div class="translate-actions">
        <button type="button" class="translate-speak-btn" data-action="speak" data-ref="speakBtn">${ICON_SVG.speaker}</button>
        <button type="button" class="translate-speak-btn slow" data-action="speak-slow" data-i18n-label="listenSlow">${ICON_SVG.speakerSmall}</button>${heart}
        <button type="button" class="translate-pin-btn" data-action="pin" data-ref="pinBtn" data-i18n-label="pin">${ICON_SVG.pin}</button>
        <button type="button" class="translate-close-btn" data-action="close" data-i18n-label="close">${ICON_SVG.close}</button>
      </div>
    </div>${support}
    <div class="translate-error-card" role="status" aria-live="polite" data-ref="errorCard" hidden>
      <p class="translate-error-msg" data-i18n="errTranslation"></p>
      <button type="button" class="translate-retry-btn" data-action="retry" data-i18n="retry"></button>
    </div>
    <div class="translate-card" data-ref="card">
      <div class="translate-card-body">
        <span class="translate-card-lang-tag" data-ref="tgtLang"></span>
        <div class="translate-target" data-ref="target"></div>
        <div class="translate-alt-inline" data-ref="alts" hidden></div>
      </div>
      <div class="translate-card-actions">
        <button type="button" class="translate-save-btn" data-action="save" data-ref="saveBtn">${ICON_SVG.star}</button>
      </div>
    </div>
    <div class="translate-footer">
      <div class="translate-saved-toast" role="status" aria-live="polite" data-ref="toast"></div>
    </div>
    <div class="translate-extras" data-ref="extras"></div>`;
}

// Textos fixos: só reaplica se idioma da UI/origem/destino mudou
function applyStaticLabels() {
  const key = `${uiLang}|${sourceLang}|${targetLang}`;
  if (key === labelsKey) return;
  labelsKey = key;
  for (const el of popupEl.querySelectorAll("[data-i18n]")) el.textContent = t(el.dataset.i18n);
  for (const el of popupEl.querySelectorAll("[data-i18n-label]")) setLabel(el, t(el.dataset.i18nLabel));
  setLabel(ui.speakBtn, `${t("listenIn")} ${LANG_NAMES[sourceLang] || sourceLang}`);
  ui.srcLang.textContent = LANG_NAMES[sourceLang] || sourceLang.toUpperCase();
  ui.tgtLang.textContent = LANG_NAMES[targetLang] || targetLang.toUpperCase();
  popupEl.setAttribute("aria-label", t("popupLabel"));
}

function setLabel(el, label) {
  el.setAttribute("aria-label", label);
  el.title = label;
}

// Nova seleção: decide posição uma vez e mostra (animação só aqui)
function openSession(rect) {
  ensurePopup();
  if (pendingHide) { clearTimeout(pendingHide); pendingHide = null; }
  clearTimeout(hideTimer);
  hideTimer = null;
  const id = ++sessionId;
  historyStack = [];
  currentState = null;
  isDragged = false;

  applyStaticLabels();
  popupEl.classList.toggle("dark-mode", darkModeEnabled);
  ui.pinBtn.classList.toggle("is-pinned", !!pinnedPosition);
  if (ui.supportCard) {
    ui.supportCard.classList.remove("is-open");
    ui.heartBtn.classList.remove("is-active");
  }

  if (popupEl.style.display === "block" && popupEl.classList.contains("is-visible")) {
    // Já visível em outro lugar: reinicia a animação sem transição de saída
    popupEl.style.transition = "none";
    popupEl.classList.remove("is-visible");
    void popupEl.offsetWidth;
    popupEl.style.transition = "";
  }
  popupEl.classList.remove("is-visible");
  placePopup(rect);
  popupEl.scrollTop = 0;
  popupEl.style.display = "block";
  popupShown = true;

  // Animação de entrada (double rAF para garantir transição CSS)
  whenStylesReady(() => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (popupShown && id === sessionId) popupEl.classList.add("is-visible");
      });
    });
  });
}

// Posição em coordenadas do documento, calculada no mouseup e mantida durante a sessão.
// Acima da seleção: ancora pela base (translate -100%), então o conteúdo cresce para cima.
function placePopup(rect) {
  const viewportPadding = 12;
  popupEl.classList.remove("tp-above");

  if (pinnedPosition) {
    popupEl.classList.add("is-pinned");
    popupEl.removeAttribute("data-placement"); // fixado: seta apontaria para o nada
    popupEl.style.maxHeight = "";
    popupEl.style.top  = pinnedPosition.top;
    popupEl.style.left = pinnedPosition.left;
    return; // clamp em afterRender, quando a altura é conhecida
  }
  popupEl.classList.remove("is-pinned");

  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const width = Math.min(460, vw - 24);
  const maxH = Math.min(520, vh - 80);

  if (rect) {
    const spaceBelow = vh - rect.bottom - 10 - viewportPadding;
    const spaceAbove = rect.top - 10 - viewportPadding;
    const placeAbove = spaceBelow < Math.min(maxH, 300) && spaceAbove > spaceBelow;
    const avail = placeAbove ? spaceAbove : spaceBelow;
    const top = window.scrollY + (placeAbove ? rect.top - 10 : rect.bottom + 10);
    const maxLeft = window.scrollX + vw - width - viewportPadding;
    const minLeft = window.scrollX + viewportPadding;
    const left = Math.min(Math.max(window.scrollX + rect.left, minLeft), maxLeft);
    popupEl.style.maxHeight = `${Math.max(160, Math.min(maxH, avail))}px`;
    popupEl.style.top  = `${top}px`;
    popupEl.style.left = `${left}px`;
    popupEl.classList.toggle("tp-above", placeAbove);
    popupEl.dataset.placement = placeAbove ? "top" : "bottom";
  } else {
    popupEl.style.maxHeight = "";
    popupEl.style.top  = `${window.scrollY + Math.max(viewportPadding, (vh - maxH) / 2)}px`;
    popupEl.style.left = `${window.scrollX + Math.max(viewportPadding, (vw - width) / 2)}px`;
    popupEl.removeAttribute("data-placement"); // centralizado: sem seleção para apontar
  }
}

// Fixado: mantém dentro da viewport conforme a altura muda
function afterRender() {
  if (!pinnedPosition || !popupEl.classList.contains("is-pinned")) return;
  const viewportPadding = 12;
  const h = popupEl.offsetHeight;
  const w = popupEl.offsetWidth;
  const top  = Math.max(viewportPadding, Math.min(parseFloat(pinnedPosition.top),  window.innerHeight - h - viewportPadding));
  const left = Math.max(viewportPadding, Math.min(parseFloat(pinnedPosition.left), window.innerWidth  - w - viewportPadding));
  popupEl.style.top  = `${top}px`;
  popupEl.style.left = `${left}px`;
}

function renderLoading(text, refresh) {
  popupEl.classList.add("is-loading");
  popupEl.classList.toggle("is-refreshing", !!refresh);
  ui.errorCard.hidden = true;
  ui.card.hidden = false;
  ui.target.textContent = t("loading");
  if (!refresh) {
    currentState = null;
    setSource(text, "");
    ui.backBtn.hidden = historyStack.length === 0;
    ui.alts.hidden = true;
    ui.alts.textContent = "";
    ui.extras.textContent = "";
    setSaved(false);
  }
  afterRender();
}

function renderError() {
  popupEl.classList.remove("is-loading", "is-refreshing");
  ui.card.hidden = true;
  ui.alts.textContent = "";
  ui.extras.textContent = "";
  ui.phonetic.hidden = true;
  ui.backBtn.hidden = historyStack.length === 0;
  ui.errorCard.hidden = false;
  afterRender();
}

function renderResult(state) {
  currentState = state;
  activeTranslation = state.translatedText;
  popupEl.classList.remove("is-loading", "is-refreshing");
  ui.errorCard.hidden = true;
  ui.card.hidden = false;

  setSource(state.sourceText, state.phonetic);
  ui.backBtn.hidden = historyStack.length === 0;
  ui.target.textContent = state.translatedText;
  renderAlternatives(state.alternatives);

  const key = state.sourceText.toLowerCase();
  setSaved(savedKeys.has(key));
  ensureSavedKeys(() => {
    if (currentState === state) setSaved(savedKeys.has(key));
  });

  const frag = document.createDocumentFragment();
  // ── Dicionário (apenas para palavras únicas) ──
  if (Array.isArray(state.dictionary) && state.dictionary.length > 0) {
    frag.appendChild(buildDictionaryBlock(state.dictionary));
  }
  // ── Definições monolíngues (apenas para palavras únicas) ──
  if (Array.isArray(state.definitions) && state.definitions.length > 0) {
    frag.appendChild(buildDefinitionsBlock(state.definitions));
  }
  // ── Frases de exemplo ──
  if (Array.isArray(state.examples) && state.examples.length > 0) {
    frag.appendChild(buildExamplesBlock(state.examples));
  }
  ui.extras.replaceChildren(frag);
  afterRender();
}

function setSource(text, phonetic) {
  ui.source.textContent = text;
  // Texto longo: botões em linha própria, fonte menor, bloco com altura limitada
  const words = text ? text.split(/\s+/).length : 0;
  const isLong = words > 3 || text.length > 40;
  popupEl.classList.toggle("is-long", isLong);
  popupEl.classList.toggle("is-paragraph", isLong && text.length > 160);
  setPhonetic(phonetic);
}

function setPhonetic(phonetic) {
  if (phonetic) {
    ui.phonetic.textContent = `/${phonetic.replace(/^[/\[]+|[/\]]+$/g, "").trim()}/`;
    ui.phonetic.hidden = false;
  } else {
    ui.phonetic.textContent = "";
    ui.phonetic.hidden = true;
  }
}

function setSaved(saved) {
  ui.saveBtn.classList.toggle("is-saved", saved);
  setLabel(ui.saveBtn, t(saved ? "wordSaved" : "saveWord"));
}

// Alternativas inline clicáveis abaixo da tradução principal
function renderAlternatives(alternatives) {
  if (!Array.isArray(alternatives) || alternatives.length === 0) {
    ui.alts.hidden = true;
    ui.alts.textContent = "";
    return;
  }
  const frag = document.createDocumentFragment();
  alternatives.forEach((item, i) => {
    if (i > 0) frag.appendChild(document.createTextNode(" • "));
    const span = document.createElement("span");
    span.className = "translate-alt-word";
    span.dataset.action = "alt";
    span.dataset.index = String(i);
    span.textContent = item;
    frag.appendChild(span);
  });
  ui.alts.replaceChildren(frag);
  ui.alts.hidden = false;
}

function buildDictionaryBlock(dictionary) {
  const dictWrapper = document.createElement("div");
  dictWrapper.className = "translate-dict";

  // Cabeçalho das colunas — DOM seguro, sem innerHTML com valores externos
  const headerRow = document.createElement("div");
  headerRow.className = "translate-dict-col-header";
  const hdrSrc = document.createElement("span");
  hdrSrc.textContent = LANG_NAMES[sourceLang] || sourceLang;
  const hdrTgt = document.createElement("span");
  hdrTgt.textContent = LANG_NAMES[targetLang] || targetLang;
  headerRow.appendChild(hdrSrc);
  headerRow.appendChild(hdrTgt);
  dictWrapper.appendChild(headerRow);

  const listenLabel = `${t("listenIn")} ${LANG_NAMES[sourceLang] || sourceLang}`;

  for (const group of dictionary) {
    const groupEl = document.createElement("div");
    groupEl.className = "translate-dict-group";

    const posEl = document.createElement("div");
    posEl.className = "translate-dict-pos";
    posEl.textContent = group.pos;
    groupEl.appendChild(posEl);

    for (const item of group.items || []) {
      const rowEl = document.createElement("div");
      rowEl.className = "translate-dict-row";

      const leftEl = document.createElement("div");
      leftEl.className = "translate-dict-left";

      const enSpeakBtn = makeButton("translate-row-speak-btn", listenLabel, "speakerSmall", "speak-text");
      enSpeakBtn.dataset.text = item.en;

      const enEl = document.createElement("div");
      enEl.className = "translate-dict-en";
      enEl.dataset.action = "retranslate";
      enEl.dataset.text = item.en;
      enEl.textContent = item.en;

      leftEl.appendChild(enSpeakBtn);
      leftEl.appendChild(enEl);

      const synEl = document.createElement("div");
      synEl.className = "translate-dict-syn";
      synEl.textContent = Array.isArray(item.pts) ? item.pts.join(", ") : "";

      rowEl.appendChild(leftEl);
      rowEl.appendChild(synEl);
      groupEl.appendChild(rowEl);
    }

    dictWrapper.appendChild(groupEl);
  }

  return dictWrapper;
}

function buildDefinitionsBlock(definitions) {
  const defSection = document.createElement("div");
  defSection.className = "translate-defs";

  const defTitle = document.createElement("div");
  defTitle.className = "translate-defs-title";
  defTitle.textContent = t("definitions");
  defSection.appendChild(defTitle);

  for (const group of definitions) {
    if (group.pos) {
      const posEl = document.createElement("div");
      posEl.className = "translate-def-pos";
      posEl.textContent = group.pos;
      defSection.appendChild(posEl);
    }
    for (const def of group.defs || []) {
      const defEl = document.createElement("p");
      defEl.className = "translate-def-item";
      defEl.textContent = def;
      defSection.appendChild(defEl);
    }
  }
  return defSection;
}

function buildExamplesBlock(examples) {
  const exSection = document.createElement("div");
  exSection.className = "translate-examples";

  const exTitle = document.createElement("div");
  exTitle.className = "translate-examples-title";
  exTitle.textContent = t("examples");
  exSection.appendChild(exTitle);

  const listenLabel = t("listenPhrase");
  const showLabel = t("showTranslation");

  for (const sentence of examples) {
    const plainText = sentence.replace(/<\/?b>/g, "").trim();

    const itemEl = document.createElement("div");
    itemEl.className = "translate-example-item";

    const sentenceHeader = document.createElement("div");
    sentenceHeader.className = "translate-example-header";

    const speakExBtn = makeButton("translate-row-speak-btn", listenLabel, "speakerSmall", "speak-text");
    speakExBtn.dataset.text = plainText;

    sentenceHeader.appendChild(speakExBtn);
    sentenceHeader.appendChild(renderSpeakableText(sentence));

    const transBtn = document.createElement("button");
    transBtn.type = "button";
    transBtn.className = "translate-example-btn";
    transBtn.dataset.action = "ex-translate";
    transBtn.dataset.text = plainText;
    transBtn.textContent = showLabel;

    const transEl = document.createElement("div");
    transEl.className = "translate-example-translation";

    itemEl.appendChild(sentenceHeader);
    itemEl.appendChild(transBtn);
    itemEl.appendChild(transEl);
    exSection.appendChild(itemEl);
  }
  return exSection;
}

function translateExample(transBtn) {
  const transEl = transBtn.nextElementSibling;
  if (!transEl) return;

  if (transEl.dataset.loaded) {
    const visible = transEl.classList.toggle("is-visible");
    transBtn.textContent = visible ? t("hideTranslation") : t("showTranslation");
    return;
  }

  transBtn.textContent = "...";
  transBtn.disabled = true;

  sendTranslate(transBtn.dataset.text || "", "example", (response) => {
    transBtn.disabled = false;
    if (response?.ok && response.translated) {
      transEl.textContent = response.translated;
      transEl.dataset.loaded = "1";
      transEl.classList.add("is-visible");
      transBtn.textContent = t("hideTranslation");
    } else {
      // erro ou cancelada (outro exemplo pedido em seguida): volta ao estado inicial
      transBtn.textContent = t("showTranslation");
    }
  });
}

// Palavras clicáveis (fala ao clicar) — tratadas pela delegação via data-action="word"
function renderSpeakableText(htmlStr) {
  const p = document.createElement("p");
  p.className = "translate-example-sentence";

  // <template> é inerte: nada do HTML externo executa ao fazer o parse
  const temp = document.createElement("template");
  temp.innerHTML = htmlStr;

  function wrapWords(container, target) {
    for (const node of Array.from(container.childNodes)) {
      if (node.nodeType === Node.TEXT_NODE) {
        node.textContent.split(/(\s+)/).forEach((part) => {
          if (/^\s+$/.test(part)) {
            target.appendChild(document.createTextNode(part));
          } else if (part) {
            const word = part.replace(/[^\p{L}'-]/gu, "").trim();
            if (word) {
              const span = document.createElement("span");
              span.className = "translate-speakable-word";
              span.dataset.action = "word";
              span.dataset.word = word;
              span.textContent = part;
              target.appendChild(span);
            } else {
              target.appendChild(document.createTextNode(part));
            }
          }
        });
      } else if (node.nodeName === "B") {
        const b = document.createElement("b");
        wrapWords(node, b);
        target.appendChild(b);
      } else {
        target.appendChild(document.importNode(node, true));
      }
    }
  }

  wrapWords(temp.content, p);
  return p;
}

// ── Eventos do popup (delegação) ──

function onPopupMouseDown(event) {
  if (event.target.closest("[data-action], button")) {
    stopPopupEvent(event);
    return;
  }
  // Texto longo rola/seleciona: não inicia arraste por ele
  if (popupEl.classList.contains("is-long") && event.target.closest(".translate-source")) return;
  if (event.button === 0 && event.target.closest(".translate-header")) {
    startDrag(event);
  }
}

function onPopupMouseUp(event) {
  if (event.target.closest("[data-action], button")) stopPopupEvent(event);
}

function onPopupClick(event) {
  const el = event.target.closest("[data-action]");
  if (!el) return;
  stopPopupEvent(event);
  const ttsLang = LANG_TTS[sourceLang] || "en-US";

  switch (el.dataset.action) {
    case "back":
      goBack();
      break;
    case "speak":
      speakText(ui.source.textContent, ttsLang);
      break;
    case "speak-slow":
      speakTextSlow(ui.source.textContent, ttsLang);
      break;
    case "support": {
      // Apoio ao projeto: expande card abaixo do header
      const open = ui.supportCard.classList.toggle("is-open");
      el.classList.toggle("is-active", open);
      break;
    }
    case "pin":
      togglePin();
      break;
    case "close":
      hidePopup();
      break;
    case "retry":
      if (lastQueryText) requestMain(lastQueryText, false);
      break;
    case "alt":
      chooseAlternative(el);
      break;
    case "save":
      onSaveClick();
      break;
    case "speak-text":
      speakText(el.dataset.text, ttsLang);
      break;
    case "word":
      speakText(el.dataset.word, ttsLang);
      break;
    case "retranslate":
      retranslate(el.dataset.text);
      break;
    case "ex-translate":
      translateExample(el);
      break;
    case "copy-pix":
      copyPixKey();
      break;
    case "donate":
      window.open(DONATION.url, "_blank");
      break;
  }
}

function chooseAlternative(span) {
  const item = currentState?.alternatives?.[Number(span.dataset.index)];
  if (item == null) return;
  ui.target.textContent = item;
  activeTranslation = item;
  for (const sib of ui.alts.querySelectorAll(".translate-alt-word.is-active")) {
    sib.classList.remove("is-active");
  }
  span.classList.add("is-active");
}

function togglePin() {
  const bcrect = popupEl.getBoundingClientRect();
  popupEl.classList.remove("tp-above");
  if (pinnedPosition) {
    // Converte coords de viewport (fixed) para documento (absolute),
    // senão o popup "teleporta" para fora da tela ao desafixar
    pinnedPosition = null;
    isDragged = false;
    ui.pinBtn.classList.remove("is-pinned");
    popupEl.classList.remove("is-pinned");
    popupEl.style.top  = `${bcrect.top + window.scrollY}px`;
    popupEl.style.left = `${bcrect.left + window.scrollX}px`;
    try { chrome.storage.local.remove("pinnedPosition"); } catch { /* contexto invalidado */ }
  } else {
    pinnedPosition = { top: `${bcrect.top}px`, left: `${bcrect.left}px` };
    ui.pinBtn.classList.add("is-pinned");
    popupEl.classList.add("is-pinned");
    popupEl.removeAttribute("data-placement");
    popupEl.style.maxHeight = "";
    popupEl.style.top  = pinnedPosition.top;
    popupEl.style.left = pinnedPosition.left;
    try { chrome.storage.local.set({ pinnedPosition }); } catch { /* contexto invalidado */ }
  }
}

function startDrag(event) {
  const startX = event.clientX;
  const startY = event.clientY;
  const isFixed = popupEl.classList.contains("is-pinned");
  const bcrect = popupEl.getBoundingClientRect();
  const origLeft = bcrect.left + (isFixed ? 0 : window.scrollX);
  const origTop  = bcrect.top  + (isFixed ? 0 : window.scrollY);
  let moved = false;
  popupEl.classList.add("is-dragging");

  const onMove = (e) => {
    if (!moved) {
      moved = true;
      popupEl.classList.remove("tp-above"); // passa a ancorar pelo topo
      popupEl.removeAttribute("data-placement"); // seta não aponta mais para a seleção
    }
    isDragged = true;
    draggingPopup = true;
    popupEl.style.left = (origLeft + e.clientX - startX) + "px";
    popupEl.style.top  = (origTop  + e.clientY - startY) + "px";
    if (pinnedPosition) {
      pinnedPosition = { top: popupEl.style.top, left: popupEl.style.left };
    }
  };
  const onUp = () => {
    popupEl.classList.remove("is-dragging");
    // Persiste posição apenas uma vez, ao soltar — não a cada mousemove
    if (moved && pinnedPosition) {
      try { chrome.storage.local.set({ pinnedPosition }); } catch { /* contexto invalidado */ }
    }
    window.removeEventListener("mousemove", onMove, true);
    window.removeEventListener("mouseup", onUp, true);
    // Libera depois do handleSelection deste mesmo mouseup
    setTimeout(() => { draggingPopup = false; }, 0);
  };
  // Captura na window: botões do popup param a propagação do mouseup
  window.addEventListener("mousemove", onMove, true);
  window.addEventListener("mouseup", onUp, true);
  event.preventDefault();
}

function hidePopup() {
  isDragged = false;
  if (!popupEl || !popupShown) return;
  popupShown = false;
  ++translateSeq; // resposta atrasada não reabre o popup
  popupEl.classList.remove("is-visible");
  clearTimeout(hideTimer);
  // Limpa o conteúdo só depois da transição de saída
  hideTimer = setTimeout(() => {
    hideTimer = null;
    if (popupShown) return;
    popupEl.style.display = "none";
    clearPopupContent();
  }, 200);
}

function clearPopupContent() {
  popupEl.classList.remove("is-loading", "is-refreshing", "is-long", "is-paragraph");
  ui.source.textContent = "";
  setPhonetic("");
  ui.target.textContent = "";
  ui.alts.textContent = "";
  ui.extras.textContent = "";
  ui.errorCard.hidden = true;
  ui.toast.classList.remove("is-visible");
  clearTimeout(toastTimer);
  historyStack = [];
  currentState = null;
}

// ── Storage: palavras salvas ──
// Lê só savedWordKeys (leve), preguiçosamente; o background mantém essa chave

function toKeySet(list) {
  return new Set(Array.isArray(list) ? list.filter((k) => typeof k === "string").map((k) => k.toLowerCase()) : []);
}

function ensureSavedKeys(callback) {
  if (savedKeysLoaded) { callback(); return; }
  if (savedKeysWaiters) { savedKeysWaiters.push(callback); return; }
  savedKeysWaiters = [callback];
  const done = (set) => {
    if (!savedKeysLoaded) { savedKeys = set; savedKeysLoaded = true; }
    const waiters = savedKeysWaiters;
    savedKeysWaiters = null;
    waiters.forEach((fn) => fn());
  };
  try {
    chrome.storage.local.get(["savedWordKeys"], (result) => {
      if (Array.isArray(result?.savedWordKeys)) { done(toKeySet(result.savedWordKeys)); return; }
      // Background ainda não migrou: lê savedWords uma única vez
      chrome.storage.local.get(["savedWords"], (res) => {
        const list = Array.isArray(res?.savedWords) ? res.savedWords : [];
        done(toKeySet(list.filter((w) => w && typeof w.word === "string").map((w) => w.word)));
      });
    });
  } catch {
    done(new Set());
  }
}

function onSaveClick() {
  const state = currentState;
  if (!state || popupEl.classList.contains("is-loading")) return;
  const translation = activeTranslation;
  ensureSavedKeys(() => {
    const word = state.sourceText;
    const key = word.toLowerCase();
    const removing = savedKeys.has(key);

    // Otimista: UI e Set local na hora; storage em seguida
    if (removing) savedKeys.delete(key);
    else savedKeys.add(key);
    if (currentState === state) setSaved(!removing);
    showToast(t(removing ? "removed" : "saved"));

    let entry = null;
    if (!removing) {
      entry = { word, translation, savedAt: Date.now() };
      const context = getLastContext();
      if (context) entry.context = context;
      if (state.phonetic) entry.phonetic = state.phonetic;
      const examples = (state.examples || []).slice(0, 3).map((s) => s.replace(/<\/?b>/g, "").trim());
      if (examples.length > 0) entry.examples = examples;
      if (sourceLang) entry.sourceLang = sourceLang;
      if (targetLang) entry.targetLang = targetLang;
    }
    persistSavedWord(key, entry);
  });
}

// Read-modify-write de savedWords em fila (cliques rápidos não se atropelam)
let saveQueue = Promise.resolve();
function persistSavedWord(key, entry) {
  saveQueue = saveQueue.then(() => new Promise((resolve) => {
    try {
      chrome.storage.local.get(["savedWords"], (result) => {
        let list = Array.isArray(result?.savedWords) ? result.savedWords : [];
        const exists = list.some((w) => w && typeof w.word === "string" && w.word.toLowerCase() === key);
        if (entry) {
          if (exists) { resolve(); return; }
          list.push(entry);
        } else {
          if (!exists) { resolve(); return; }
          list = list.filter((w) => !(w && typeof w.word === "string" && w.word.toLowerCase() === key));
        }
        chrome.storage.local.set({ savedWords: list }, () => {
          void chrome.runtime.lastError;
          resolve();
        });
      });
    } catch {
      resolve();
    }
  }));
}

let toastTimer = null;
function showToast(message) {
  const toastEl = ui?.toast;
  if (!toastEl) return;
  toastEl.replaceChildren(icon("check"), document.createTextNode(" " + message));
  toastEl.classList.add("is-visible");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toastEl.classList.remove("is-visible");
  }, 2200);
}

// ── Apoie o projeto (config em ui-strings.js: DONATION) ──

let supportFeedbackTimer = null;
function copyPixKey() {
  copyToClipboard(DONATION.pixKey).then(() => {
    if (!ui.supportFeedback) return;
    ui.supportFeedback.textContent = t("pixCopied");
    clearTimeout(supportFeedbackTimer);
    supportFeedbackTimer = setTimeout(() => { ui.supportFeedback.textContent = ""; }, 2500);
  });
}

function copyToClipboard(text) {
  return navigator.clipboard.writeText(text).catch(() => {
    // Fallback para páginas que bloqueiam a Clipboard API no content script
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    ta.remove();
  });
}

// ── Utilitários ──

function getLastContext() {
  const sel = lastSelection;
  if (!sel) return "";
  if (sel.context === null) sel.context = getContextSentence(sel.text, sel.range);
  return sel.context;
}

// Trecho (~280 chars) ao redor da seleção, lendo só ±CONTEXT_RADIUS chars do bloco
function getContextSentence(word, range) {
  if (!word || !range) return "";
  try {
    const container = range.commonAncestorContainer;
    const el = container.nodeType === 3 ? container.parentElement : container;
    if (!el || !el.closest) return "";
    const block = el.closest("p, li, td, blockquote, article") || el;
    const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
    const before = textBefore(walker, range.startContainer, range.startOffset, CONTEXT_RADIUS);
    const after  = textAfter(walker, range.endContainer, range.endOffset, CONTEXT_RADIUS);

    const pre = before.replace(/\s+/g, " ").trimStart();
    const text = (pre + word + after).replace(/\s+/g, " ").trim();
    if (!text) return "";
    const lower = text.toLowerCase();
    const needle = word.toLowerCase().replace(/\s+/g, " ");
    let idx = lower.indexOf(needle, Math.max(0, pre.length - 2));
    if (idx === -1) idx = lower.indexOf(needle);
    if (idx === -1) return text.slice(0, 280).trim();
    const start = Math.max(0, idx - 100);
    return text.slice(start, start + 280).trim();
  } catch {
    return "";
  }
}

function lastDescendant(node) {
  while (node.lastChild) node = node.lastChild;
  return node;
}

function textBefore(walker, container, offset, limit) {
  let out = "";
  if (container.nodeType === 3) {
    out = container.data.slice(Math.max(0, offset - limit), offset);
    walker.currentNode = container;
  } else {
    const child = container.childNodes[offset];
    if (child) {
      walker.currentNode = child;
    } else {
      const last = lastDescendant(container);
      if (last.nodeType === 3) out = last.data.slice(-limit);
      walker.currentNode = last;
    }
  }
  while (out.length < limit) {
    const n = walker.previousNode();
    if (!n) break;
    out = n.data.slice(-(limit - out.length)) + out;
  }
  return out;
}

function textAfter(walker, container, offset, limit) {
  let out = "";
  if (container.nodeType === 3) {
    out = container.data.slice(offset, offset + limit);
    walker.currentNode = container;
  } else {
    const child = container.childNodes[offset];
    if (child && child.nodeType === 3) {
      out = child.data.slice(0, limit);
      walker.currentNode = child;
    } else {
      // elemento: nextNode() desce nos filhos; fim do container: pula a subárvore
      walker.currentNode = child || lastDescendant(container);
    }
  }
  while (out.length < limit) {
    const n = walker.nextNode();
    if (!n) break;
    out += n.data.slice(0, limit - out.length);
  }
  return out;
}

function looksLikeEnglish(text) {
  if (!text || !text.trim()) return false;

  if (sourceLang === "en") {
    // Permite ASCII + latinos acentuados (café, naïve) + aspas tipográficas ('don't', "quote")
    return !/[^\x00-\x7FÀ-ɏ‘-‟]/.test(text);
  }

  return /\p{L}/u.test(text);
}

// ── Áudio: um único elemento reaproveitado ──

let ttsAudio = null;
let ttsToken = 0;

function ttsUrl(value, lang) {
  const url = new URL("https://translate.google.com/translate_tts");
  url.searchParams.set("ie", "UTF-8");
  url.searchParams.set("tl", lang || "en-US");
  url.searchParams.set("client", "tw-ob");
  url.searchParams.set("q", value);
  url.searchParams.set("total", "1");
  url.searchParams.set("idx", "0");
  url.searchParams.set("textlen", String(value.length));
  return url.toString();
}

function getAudio() {
  if (!ttsAudio) {
    ttsAudio = new Audio();
    ttsAudio.preload = "auto";
  }
  return ttsAudio;
}

// Pré-carrega o áudio da palavra principal (só se nada estiver tocando)
function preloadAudio(text, lang) {
  const value = (text || "").trim();
  if (!value || value.length > 200) return;
  const audio = getAudio();
  if (!audio.paused && !audio.ended) return;
  const url = ttsUrl(value, lang);
  if (audio.src !== url) audio.src = url;
}

function speakText(text, lang) {
  const value = (text || "").trim();
  if (!value) return;

  const url = ttsUrl(value, lang);
  const audio = getAudio();
  const token = ++ttsToken;
  if (audio.src !== url || audio.error) {
    audio.src = url;
  } else {
    try { audio.currentTime = 0; } catch { /* ainda sem metadata */ }
  }
  audio.play().catch((err) => {
    // AbortError = interrompido por outro play/src; não é falha do áudio
    if (token !== ttsToken || err?.name === "AbortError") return;
    fallbackSpeechSynthesis(value, lang);
  });
}

function fallbackSpeechSynthesis(text, lang) {
  if (!("speechSynthesis" in window)) return;
  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = lang || "en-US";
  utterance.rate = 0.95;
  window.speechSynthesis.speak(utterance);
}

function speakTextSlow(text, lang) {
  const value = (text || "").trim();
  if (!value) return;
  if (!("speechSynthesis" in window)) return;
  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(value);
  utterance.lang = lang || "en-US";
  utterance.rate = 0.55;
  window.speechSynthesis.speak(utterance);
}

function stopPopupEvent(event) {
  event.preventDefault();
  event.stopPropagation();
}

function makeButton(className, ariaLabel, iconName, action) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = className;
  btn.dataset.action = action;
  setLabel(btn, ariaLabel);
  btn.appendChild(icon(iconName));
  return btn;
}

// ── SVG icons (parse uma vez, depois só clone) ──

const ICON_SVG = {
  speaker: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 10v4h4l5 4V6L7 10H3zm13.5 2a3.5 3.5 0 0 0-2.1-3.2v6.4a3.5 3.5 0 0 0 2.1-3.2zm0-7a1 1 0 0 0 0 2c2.8 0 5 2.2 5 5s-2.2 5-5 5a1 1 0 0 0 0 2c3.9 0 7-3.1 7-7s-3.1-7-7-7z"/></svg>',
  speakerSmall: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 10v4h4l5 4V6L7 10H3zm13.5 2a3.5 3.5 0 0 0-2.1-3.2v6.4a3.5 3.5 0 0 0 2.1-3.2z"/></svg>',
  star: '<svg viewBox="0 0 24 24" aria-hidden="true"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>',
  check: '<svg viewBox="0 0 24 24" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>',
  back: '<svg viewBox="0 0 24 24" aria-hidden="true"><polyline points="15 18 9 12 15 6"/></svg>',
  pin: '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 17v5M9 10.5V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v5.5l2 2v1H7v-1l2-2z"/></svg>',
  heart: '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>',
  close: '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>',
};

const iconTemplates = {};
function icon(name) {
  let tpl = iconTemplates[name];
  if (!tpl) {
    tpl = document.createElement("template");
    tpl.innerHTML = ICON_SVG[name];
    iconTemplates[name] = tpl;
  }
  return tpl.content.firstElementChild.cloneNode(true);
}
