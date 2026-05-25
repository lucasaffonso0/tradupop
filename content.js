let popupEl = null;
let hideTimer = null;
let savedWords = new Set();
let storageLoaded = false;
let currentRect = null;
let historyStack = [];
let currentState = null;
let shortcutKey = "q";
let darkModeEnabled = false;
let sourceLang = "en";
let targetLang = "pt";
let uiLang = "pt";

function t(key) {
  return (UI_STRINGS[uiLang] || UI_STRINGS["pt"])[key] || key;
}

const LOADING_SENTINEL = "\x00loading\x00";

const LANG_TTS = {
  en: "en-US", pt: "pt-BR", es: "es-ES", fr: "fr-FR",
  de: "de-DE", it: "it-IT", ja: "ja-JP", zh: "zh-CN",
  ko: "ko-KR", ru: "ru-RU"
};

const LANG_NAMES = {
  en: "English",   pt: "Português", es: "Español",
  fr: "Français",  de: "Deutsch",   it: "Italiano",
  ja: "日本語",    zh: "中文",      ko: "한국어",   ru: "Русский"
};

// Carrega configurações iniciais
chrome.storage.local.get(["shortcutKey", "darkMode", "sourceLang", "targetLang", "uiLang"], (result) => {
  if (result.shortcutKey) shortcutKey = result.shortcutKey.toLowerCase();
  darkModeEnabled = !!result.darkMode;
  if (result.sourceLang) sourceLang = result.sourceLang;
  if (result.targetLang) targetLang = result.targetLang;
  if (result.uiLang) uiLang = result.uiLang;
});

// Reage a mudanças em tempo real
chrome.storage.onChanged.addListener((changes) => {
  if (changes.shortcutKey) shortcutKey = (changes.shortcutKey.newValue || "q").toLowerCase();
  if (changes.darkMode) {
    darkModeEnabled = !!changes.darkMode.newValue;
    if (popupEl) popupEl.classList.toggle("dark-mode", darkModeEnabled);
  }
  if (changes.sourceLang) sourceLang = changes.sourceLang.newValue || "en";
  if (changes.targetLang) targetLang = changes.targetLang.newValue || "pt";
  if (changes.uiLang) uiLang = changes.uiLang.newValue || "pt";
});

document.addEventListener("mouseup", handleSelection);
document.addEventListener("keydown", (event) => {
  if (event.ctrlKey && event.key.toLowerCase() === shortcutKey) {
    const text = window.getSelection()?.toString().trim();
    if (text) {
      event.preventDefault();
      speakText(text, LANG_TTS[sourceLang] || "en-US");
    }
  }
});
document.addEventListener("keyup", (event) => {
  if (event.key === "Escape") {
    hidePopup();
  }
});
document.addEventListener("mousedown", (event) => {
  if (popupEl && !popupEl.contains(event.target)) {
    hidePopup();
  }
});

function handleSelection(event) {
  if (popupEl && event?.target && popupEl.contains(event.target)) {
    return;
  }

  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) {
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

  const range = selection.getRangeAt(0);
  const rect = range.getBoundingClientRect();
  if (!rect || (rect.width === 0 && rect.height === 0)) {
    return;
  }

  historyStack = [];
  currentState = null;
  showPopup(LOADING_SENTINEL, rect);

  if (!chrome?.runtime?.id) {
    showPopup("Erro: extensão indisponível nesta página.", rect);
    autoHide();
    return;
  }

  chrome.runtime.sendMessage({ type: "TRANSLATE_TEXT", text }, (response) => {
    if (chrome.runtime.lastError) {
      showPopup("Erro: não foi possível traduzir.", rect);
      autoHide();
      return;
    }

    if (!response?.ok) {
      showPopup(`Erro: ${response?.error || "falha inesperada"}`, rect);
      autoHide();
      return;
    }

    showPopup(
      response.translated,
      rect,
      text,
      response.alternatives || [],
      response.dictionary || [],
      response.examples || []
    );
  });
}

function retranslate(word) {
  if (currentState) historyStack.push(currentState);
  showPopup(LOADING_SENTINEL, currentRect, word);
  chrome.runtime.sendMessage({ type: "TRANSLATE_TEXT", text: word }, (response) => {
    if (chrome.runtime.lastError || !response?.ok) {
      showPopup(`Erro: ${response?.error || "falha inesperada"}`, currentRect);
      autoHide();
      return;
    }
    showPopup(response.translated, currentRect, word, response.alternatives || [], response.dictionary || [], response.examples || []);
  });
}

function goBack() {
  const prev = historyStack.pop();
  if (prev) {
    showPopup(prev.translatedText, currentRect, prev.sourceText, prev.alternatives, prev.dictionary, prev.examples);
  }
}

function showPopup(
  translatedText,
  rect,
  sourceText = "",
  alternatives = [],
  dictionary = [],
  examples = []
) {
  if (rect) currentRect = rect;

  // Salva estado atual para o histórico (só quando é uma tradução completa)
  if (translatedText !== LOADING_SENTINEL && sourceText) {
    currentState = { translatedText, sourceText, alternatives, dictionary, examples };
  }

  if (!popupEl) {
    popupEl = document.createElement("div");
    popupEl.className = "translate-selection-popup";
    document.body.appendChild(popupEl);
  }

  popupEl.innerHTML = "";
  popupEl.classList.remove("is-loading", "is-visible");
  popupEl.classList.toggle("dark-mode", darkModeEnabled);

  if (translatedText === LOADING_SENTINEL) {
    popupEl.classList.add("is-loading");
  }

  // ── Header: botão voltar (se houver histórico) + palavra em inglês + áudio EN ──
  if (sourceText) {
    const headerEl = document.createElement("div");
    headerEl.className = "translate-header";

    const titleWrap = document.createElement("div");
    titleWrap.className = "translate-title-wrap";

    // Botão de voltar — só aparece quando há histórico
    if (historyStack.length > 0) {
      const backBtn = document.createElement("button");
      backBtn.type = "button";
      backBtn.className = "translate-back-btn";
      backBtn.setAttribute("aria-label", t("back"));
      backBtn.innerHTML = backArrowSvg() + " " + t("back");
      backBtn.addEventListener("mousedown", stopPopupEvent);
      backBtn.addEventListener("mouseup", stopPopupEvent);
      backBtn.addEventListener("click", (event) => {
        stopPopupEvent(event);
        goBack();
      });
      titleWrap.appendChild(backBtn);
    }

    const langTag = document.createElement("span");
    langTag.className = "translate-source-lang-tag";
    langTag.textContent = LANG_NAMES[sourceLang] || sourceLang.toUpperCase();

    const sourceEl = document.createElement("div");
    sourceEl.className = "translate-source";
    sourceEl.textContent = sourceText;

    titleWrap.appendChild(langTag);
    titleWrap.appendChild(sourceEl);

    const actionsEl = document.createElement("div");
    actionsEl.className = "translate-actions";

    const speakEnBtn = makeButton("translate-speak-btn", `${t("listenIn")} ${LANG_NAMES[sourceLang] || sourceLang}`, speakerSvg());
    speakEnBtn.addEventListener("mousedown", stopPopupEvent);
    speakEnBtn.addEventListener("mouseup", stopPopupEvent);
    speakEnBtn.addEventListener("click", (event) => {
      stopPopupEvent(event);
      speakText(sourceText, LANG_TTS[sourceLang] || "en-US");
    });

    actionsEl.appendChild(speakEnBtn);
    headerEl.appendChild(titleWrap);
    headerEl.appendChild(actionsEl);
    popupEl.appendChild(headerEl);
  }

  // ── Card: tradução em português + salvar ──
  const cardEl = document.createElement("div");
  cardEl.className = "translate-card";

  const cardBody = document.createElement("div");
  cardBody.className = "translate-card-body";

  const ptLangTag = document.createElement("span");
  ptLangTag.className = "translate-card-lang-tag";
  ptLangTag.textContent = LANG_NAMES[targetLang] || targetLang.toUpperCase();

  const targetEl = document.createElement("div");
  targetEl.className = "translate-target";
  targetEl.textContent = translatedText === LOADING_SENTINEL ? t("loading") : translatedText;

  cardBody.appendChild(ptLangTag);
  cardBody.appendChild(targetEl);

  // Alternativas inline clicáveis abaixo da tradução principal
  if (Array.isArray(alternatives) && alternatives.length > 0) {
    const altInlineEl = document.createElement("div");
    altInlineEl.className = "translate-alt-inline";

    alternatives.forEach((item, i) => {
      if (i > 0) {
        altInlineEl.appendChild(document.createTextNode(" • "));
      }
      const span = document.createElement("span");
      span.className = "translate-alt-word";
      span.textContent = item;
      span.addEventListener("mousedown", stopPopupEvent);
      span.addEventListener("click", (event) => {
        stopPopupEvent(event);
        targetEl.textContent = item;
        // Marca palavra ativa e remove das demais
        for (const sib of altInlineEl.querySelectorAll(".translate-alt-word")) {
          sib.classList.remove("is-active");
        }
        span.classList.add("is-active");
      });
      altInlineEl.appendChild(span);
    });

    cardBody.appendChild(altInlineEl);
  }

  const cardActions = document.createElement("div");
  cardActions.className = "translate-card-actions";

  const saveBtn = makeButton("translate-save-btn", t("saveWord"), starSvg());
  saveBtn.addEventListener("mousedown", stopPopupEvent);
  saveBtn.addEventListener("mouseup", stopPopupEvent);

  cardActions.appendChild(saveBtn);
  cardEl.appendChild(cardBody);
  cardEl.appendChild(cardActions);
  popupEl.appendChild(cardEl);

  // ── Footer: toast "Salvo!" ──
  const footerEl = document.createElement("div");
  footerEl.className = "translate-footer";

  const toastEl = document.createElement("div");
  toastEl.className = "translate-saved-toast";
  toastEl.innerHTML = checkSvg() + " " + t("saved");

  footerEl.appendChild(toastEl);
  popupEl.appendChild(footerEl);

  // Inicializa estado do botão salvar após carregar storage
  if (sourceText && translatedText !== "Traduzindo...") {
    loadSavedWords(() => {
      const key = sourceText.toLowerCase();
      if (savedWords.has(key)) {
        saveBtn.classList.add("is-saved");
        saveBtn.setAttribute("aria-label", t("wordSaved"));
      }
      saveBtn.addEventListener("click", (event) => {
        stopPopupEvent(event);
        toggleSaveWord(sourceText, translatedText, saveBtn, toastEl);
      });
    });
  }

  // ── Dicionário (apenas para palavras únicas) ──
  if (Array.isArray(dictionary) && dictionary.length > 0) {
    renderDictionaryBlock(popupEl, dictionary);
  }

  // ── Frases de exemplo ──
  if (Array.isArray(examples) && examples.length > 0) {
    const exSection = document.createElement("div");
    exSection.className = "translate-examples";

    const exTitle = document.createElement("div");
    exTitle.className = "translate-examples-title";
    exTitle.textContent = t("examples");
    exSection.appendChild(exTitle);

    for (const sentence of examples) {
      const itemEl = document.createElement("div");
      itemEl.className = "translate-example-item";

      const sentenceHeader = document.createElement("div");
      sentenceHeader.className = "translate-example-header";

      const p = document.createElement("p");
      p.className = "translate-example-sentence";
      p.innerHTML = sentence;

      const speakExBtn = makeButton("translate-row-speak-btn", "Ouvir frase", speakerSvgSmall());
      speakExBtn.addEventListener("mousedown", stopPopupEvent);
      speakExBtn.addEventListener("mouseup", stopPopupEvent);
      speakExBtn.addEventListener("click", (event) => {
        stopPopupEvent(event);
        const plainText = sentence.replace(/<\/?b>/g, "").trim();
        speakText(plainText, LANG_TTS[sourceLang] || "en-US");
      });

      sentenceHeader.appendChild(speakExBtn);
      sentenceHeader.appendChild(p);

      const transBtn = document.createElement("button");
      transBtn.type = "button";
      transBtn.className = "translate-example-btn";
      transBtn.textContent = t("showTranslation");

      const transEl = document.createElement("div");
      transEl.className = "translate-example-translation";

      transBtn.addEventListener("mousedown", stopPopupEvent);
      transBtn.addEventListener("click", (event) => {
        stopPopupEvent(event);

        if (transEl.dataset.loaded) {
          const visible = transEl.classList.toggle("is-visible");
          transBtn.textContent = visible ? t("hideTranslation") : t("showTranslation");
          return;
        }

        const plainText = sentence.replace(/<\/?b>/g, "").trim();
        transBtn.textContent = "...";
        transBtn.disabled = true;

        chrome.runtime.sendMessage({ type: "TRANSLATE_TEXT", text: plainText }, (response) => {
          transBtn.disabled = false;
          if (response?.ok && response.translated) {
            transEl.textContent = response.translated;
            transEl.dataset.loaded = "1";
            transEl.classList.add("is-visible");
            transBtn.textContent = t("hideTranslation");
          } else {
            transBtn.textContent = t("showTranslation");
          }
        });
      });

      itemEl.appendChild(sentenceHeader);
      itemEl.appendChild(transBtn);
      itemEl.appendChild(transEl);
      exSection.appendChild(itemEl);
    }

    popupEl.appendChild(exSection);
  }

  // ── Posicionamento ──
  popupEl.style.display = "block";

  const popupRect = popupEl.getBoundingClientRect();
  const viewportPadding = 12;
  const desiredTop = rect.bottom + 10;
  const placeAbove =
    desiredTop + popupRect.height > window.innerHeight - viewportPadding &&
    rect.top - popupRect.height - 10 > viewportPadding;

  const top = placeAbove
    ? window.scrollY + rect.top - popupRect.height - 10
    : window.scrollY + desiredTop;

  const maxLeft = window.scrollX + window.innerWidth - popupRect.width - viewportPadding;
  const minLeft = window.scrollX + viewportPadding;
  const left = Math.min(Math.max(window.scrollX + rect.left, minLeft), maxLeft);

  popupEl.style.top = `${top}px`;
  popupEl.style.left = `${left}px`;
  popupEl.dataset.placement = placeAbove ? "top" : "bottom";

  clearTimeout(hideTimer);

  // Animação de entrada (double rAF para garantir transição CSS)
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      if (popupEl) popupEl.classList.add("is-visible");
    });
  });
}

function renderDictionaryBlock(container, dictionary) {
  const dictWrapper = document.createElement("div");
  dictWrapper.className = "translate-dict";

  // Cabeçalho das colunas
  const headerRow = document.createElement("div");
  headerRow.className = "translate-dict-col-header";
  headerRow.innerHTML =
    `<span>${LANG_NAMES[sourceLang] || sourceLang}</span><span>${LANG_NAMES[targetLang] || targetLang}</span>`;
  dictWrapper.appendChild(headerRow);

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

      const enSpeakBtn = makeButton("translate-row-speak-btn", `${t("listenIn")} ${LANG_NAMES[sourceLang] || sourceLang}`, speakerSvgSmall());
      enSpeakBtn.addEventListener("mousedown", stopPopupEvent);
      enSpeakBtn.addEventListener("mouseup", stopPopupEvent);
      enSpeakBtn.addEventListener("click", (event) => {
        stopPopupEvent(event);
        speakText(item.en, LANG_TTS[sourceLang] || "en-US");
      });

      const enEl = document.createElement("div");
      enEl.className = "translate-dict-en";
      enEl.textContent = item.en;
      enEl.addEventListener("mousedown", stopPopupEvent);
      enEl.addEventListener("click", (event) => {
        stopPopupEvent(event);
        retranslate(item.en);
      });

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

  container.appendChild(dictWrapper);
}

function hidePopup() {
  if (popupEl) {
    popupEl.classList.remove("is-visible");
    popupEl.style.display = "none";
  }
  clearTimeout(hideTimer);
}

function autoHide() {
  clearTimeout(hideTimer);
  hideTimer = setTimeout(hidePopup, 3000);
}

// ── Storage: palavras salvas ──

function loadSavedWords(callback) {
  if (storageLoaded) {
    callback();
    return;
  }
  chrome.storage.local.get(["savedWords"], (result) => {
    const list = Array.isArray(result.savedWords) ? result.savedWords : [];
    savedWords = new Set(list.map((w) => w.word.toLowerCase()));
    storageLoaded = true;
    callback();
  });
}

function toggleSaveWord(word, translation, saveBtn, toastEl) {
  const key = word.toLowerCase();
  chrome.storage.local.get(["savedWords"], (result) => {
    let list = Array.isArray(result.savedWords) ? result.savedWords : [];

    if (savedWords.has(key)) {
      savedWords.delete(key);
      list = list.filter((w) => w.word.toLowerCase() !== key);
      saveBtn.classList.remove("is-saved");
      saveBtn.setAttribute("aria-label", t("saveWord"));
    } else {
      savedWords.add(key);
      list.push({ word, translation, savedAt: Date.now() });
      saveBtn.classList.add("is-saved");
      saveBtn.setAttribute("aria-label", t("wordSaved"));
      showSavedToast(toastEl);
    }

    chrome.storage.local.set({ savedWords: list });
  });
}

function showSavedToast(toastEl) {
  if (!toastEl) return;
  toastEl.classList.add("is-visible");
  setTimeout(() => {
    toastEl.classList.remove("is-visible");
  }, 2200);
}

// ── Utilitários ──

function looksLikeEnglish(text) {
  if (!text || !text.trim()) return false;

  if (sourceLang === "en") {
    return !/[^\x00-\x7F]/.test(text);
  }

  return /\p{L}/u.test(text);
}

function speakText(text, lang) {
  const value = (text || "").trim();
  if (!value) return;

  const url = new URL("https://translate.google.com/translate_tts");
  url.searchParams.set("ie", "UTF-8");
  url.searchParams.set("tl", lang || "en-US");
  url.searchParams.set("client", "tw-ob");
  url.searchParams.set("q", value);
  url.searchParams.set("total", "1");
  url.searchParams.set("idx", "0");
  url.searchParams.set("textlen", String(value.length));

  const audio = new Audio(url.toString());
  audio.play().catch(() => fallbackSpeechSynthesis(value, lang));
}

function fallbackSpeechSynthesis(text, lang) {
  if (!("speechSynthesis" in window)) return;
  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = lang || "en-US";
  utterance.rate = 0.95;
  window.speechSynthesis.speak(utterance);
}

function stopPopupEvent(event) {
  event.preventDefault();
  event.stopPropagation();
}

function makeButton(className, ariaLabel, svgContent) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = className;
  btn.setAttribute("aria-label", ariaLabel);
  btn.title = ariaLabel;
  btn.innerHTML = svgContent;
  return btn;
}

// ── SVG icons ──

function speakerSvg() {
  return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 10v4h4l5 4V6L7 10H3zm13.5 2a3.5 3.5 0 0 0-2.1-3.2v6.4a3.5 3.5 0 0 0 2.1-3.2zm0-7a1 1 0 0 0 0 2c2.8 0 5 2.2 5 5s-2.2 5-5 5a1 1 0 0 0 0 2c3.9 0 7-3.1 7-7s-3.1-7-7-7z"/></svg>';
}

function speakerSvgSmall() {
  return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 10v4h4l5 4V6L7 10H3zm13.5 2a3.5 3.5 0 0 0-2.1-3.2v6.4a3.5 3.5 0 0 0 2.1-3.2z"/></svg>';
}

function starSvg() {
  return '<svg viewBox="0 0 24 24" aria-hidden="true"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>';
}

function checkSvg() {
  return '<svg viewBox="0 0 24 24" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>';
}

function backArrowSvg() {
  return '<svg viewBox="0 0 24 24" aria-hidden="true"><polyline points="15 18 9 12 15 6"/></svg>';
}
