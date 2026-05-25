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
let pinnedPosition = null; // { top, left } quando fixado
let isDragged = false;
let lastSelectionContext = "";

function t(key) {
  return (UI_STRINGS[uiLang] || UI_STRINGS["pt"])[key] || key;
}

const LOADING_SENTINEL = "\x00loading\x00";
const ERROR_SENTINEL   = "\x00error\x00";
let lastQueryText = null;

// LANG_TTS e LANG_NAMES são globais definidos em ui-strings.js

// Carrega configurações iniciais
chrome.storage.local.get(["shortcutKey", "darkMode", "sourceLang", "targetLang", "uiLang", "pinnedPosition", "savedWords"], (result) => {
  if (result.shortcutKey) shortcutKey = result.shortcutKey.toLowerCase();
  darkModeEnabled = !!result.darkMode;
  if (result.sourceLang) sourceLang = result.sourceLang;
  if (result.targetLang) targetLang = result.targetLang;
  if (result.uiLang) uiLang = result.uiLang;
  if (result.pinnedPosition) pinnedPosition = result.pinnedPosition;
  const list = Array.isArray(result.savedWords) ? result.savedWords : [];
  savedWords = new Set(list.map((w) => w.word.toLowerCase()));
  storageLoaded = true;
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
  if (changes.pinnedPosition) {
    pinnedPosition = changes.pinnedPosition.newValue || null;
    if (!pinnedPosition && popupEl) {
      popupEl.classList.remove("is-pinned");
      isDragged = false;
    }
  }
});

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type !== "TRANSLATE_SELECTION") return;
  const text = (message.text || "").trim();
  if (!text) return;
  lastSelectionContext = getContextSentence(text);
  const sel = window.getSelection();
  let rect = null;
  if (sel && sel.rangeCount > 0) {
    const r = sel.getRangeAt(0).getBoundingClientRect();
    if (r && (r.width > 0 || r.height > 0)) rect = r;
  }
  if (!chrome?.runtime?.id) {
    lastQueryText = text;
    showPopup(ERROR_SENTINEL, rect);
    return;
  }
  translateText(text, rect);
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
// Adia o hide para dar chance ao mouseup registrar nova seleção
let pendingHide = null;
document.addEventListener("mousedown", (event) => {
  if (popupEl && !popupEl.contains(event.target)) {
    pendingHide = setTimeout(() => { pendingHide = null; hidePopup(); }, 0);
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

  if (pendingHide) { clearTimeout(pendingHide); pendingHide = null; }
  historyStack = [];
  currentState = null;
  isDragged = false;
  lastSelectionContext = getContextSentence(text);

  if (!chrome?.runtime?.id) {
    lastQueryText = text;
    showPopup(ERROR_SENTINEL, rect);
    return;
  }

  translateText(text, rect);
}

function translateText(text, rect) {
  lastQueryText = text;
  showPopup(LOADING_SENTINEL, rect);
  chrome.runtime.sendMessage({ type: "TRANSLATE_TEXT", text }, (response) => {
    if (chrome.runtime.lastError) {
      showPopup(ERROR_SENTINEL, rect);
      return;
    }
    if (!response?.ok) {
      showPopup(ERROR_SENTINEL, rect);
      return;
    }
    showPopup(
      response.translated,
      rect,
      text,
      response.alternatives || [],
      response.dictionary || [],
      response.examples || [],
      response.phonetic || ""
    );
  });
}

function retranslate(word) {
  if (currentState) historyStack.push(currentState);
  lastQueryText = word;
  showPopup(LOADING_SENTINEL, currentRect, word);
  chrome.runtime.sendMessage({ type: "TRANSLATE_TEXT", text: word }, (response) => {
    if (chrome.runtime.lastError || !response?.ok) {
      showPopup(ERROR_SENTINEL, currentRect);
      return;
    }
    showPopup(response.translated, currentRect, word, response.alternatives || [], response.dictionary || [], response.examples || [], response.phonetic || "");
  });
}

function goBack() {
  const prev = historyStack.pop();
  if (prev) {
    showPopup(prev.translatedText, currentRect, prev.sourceText, prev.alternatives, prev.dictionary, prev.examples, prev.phonetic || "");
  }
}

function showPopup(
  translatedText,
  rect,
  sourceText = "",
  alternatives = [],
  dictionary = [],
  examples = [],
  phonetic = ""
) {
  if (rect) currentRect = rect;

  // Salva estado atual para o histórico (só quando é uma tradução completa)
  if (translatedText !== LOADING_SENTINEL && sourceText) {
    currentState = { translatedText, sourceText, alternatives, dictionary, examples, phonetic };
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
  const headerEl = document.createElement("div");
  headerEl.className = "translate-header";

  if (sourceText) {
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
    if (phonetic) {
      const phoneticEl = document.createElement("div");
      phoneticEl.className = "translate-source-phonetic";
      phoneticEl.textContent = `/${phonetic.replace(/^[/\[]+|[/\]]+$/g, "").trim()}/`;
      titleWrap.appendChild(phoneticEl);
    }

    headerEl.appendChild(titleWrap);
  }

  const actionsEl = document.createElement("div");
  actionsEl.className = "translate-actions";

  if (sourceText) {
    const ttsLang = LANG_TTS[sourceLang] || "en-US";
    const speakEnBtn = makeButton("translate-speak-btn", `${t("listenIn")} ${LANG_NAMES[sourceLang] || sourceLang}`, speakerSvg());
    speakEnBtn.addEventListener("mousedown", stopPopupEvent);
    speakEnBtn.addEventListener("mouseup", stopPopupEvent);
    speakEnBtn.addEventListener("click", (event) => {
      stopPopupEvent(event);
      speakText(sourceText, ttsLang);
    });
    actionsEl.appendChild(speakEnBtn);

    const speakSlowBtn = makeButton("translate-speak-btn slow", t("listenSlow"), speakerSvgSmall());
    speakSlowBtn.addEventListener("mousedown", stopPopupEvent);
    speakSlowBtn.addEventListener("mouseup", stopPopupEvent);
    speakSlowBtn.addEventListener("click", (event) => {
      stopPopupEvent(event);
      speakTextSlow(sourceText, ttsLang);
    });
    actionsEl.appendChild(speakSlowBtn);
  }

  const pinBtn = makeButton("translate-pin-btn", t("pin"), pinSvg());
  pinBtn.classList.toggle("is-pinned", !!pinnedPosition);
  pinBtn.addEventListener("mousedown", stopPopupEvent);
  pinBtn.addEventListener("click", (e) => {
    stopPopupEvent(e);
    if (pinnedPosition) {
      pinnedPosition = null;
      isDragged = false;
      pinBtn.classList.remove("is-pinned");
      popupEl.classList.remove("is-pinned");
      chrome.storage.local.remove("pinnedPosition");
    } else {
      const bcrect = popupEl.getBoundingClientRect();
      pinnedPosition = { top: `${bcrect.top}px`, left: `${bcrect.left}px` };
      pinBtn.classList.add("is-pinned");
      popupEl.classList.add("is-pinned");
      popupEl.style.top  = pinnedPosition.top;
      popupEl.style.left = pinnedPosition.left;
      chrome.storage.local.set({ pinnedPosition });
    }
  });

  const closeBtn = makeButton("translate-close-btn", t("close"), closeSvg());
  closeBtn.addEventListener("mousedown", stopPopupEvent);
  closeBtn.addEventListener("click", (e) => {
    stopPopupEvent(e);
    hidePopup();
  });

  actionsEl.appendChild(pinBtn);
  actionsEl.appendChild(closeBtn);
  headerEl.appendChild(actionsEl);
  popupEl.appendChild(headerEl);

  if (sourceText) {
    makeDraggable(popupEl, headerEl);
  }

  // ── Estado de erro ──
  if (translatedText === ERROR_SENTINEL) {
    const errEl = document.createElement("div");
    errEl.className = "translate-error-card";
    const errMsg = document.createElement("p");
    errMsg.className = "translate-error-msg";
    errMsg.textContent = t("errTranslation");
    const retryBtn = document.createElement("button");
    retryBtn.className = "translate-retry-btn";
    retryBtn.textContent = t("retry");
    retryBtn.addEventListener("mousedown", stopPopupEvent);
    retryBtn.addEventListener("click", (e) => {
      stopPopupEvent(e);
      if (lastQueryText) translateText(lastQueryText, currentRect);
    });
    errEl.appendChild(errMsg);
    errEl.appendChild(retryBtn);
    popupEl.appendChild(errEl);
  }

  // ── Card: tradução em português + salvar ──
  if (translatedText !== ERROR_SENTINEL) {
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
  let activeTranslation = translatedText;

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
        activeTranslation = item;
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
  if (sourceText && translatedText !== LOADING_SENTINEL) {
    loadSavedWords(() => {
      const key = sourceText.toLowerCase();
      if (savedWords.has(key)) {
        saveBtn.classList.add("is-saved");
        saveBtn.setAttribute("aria-label", t("wordSaved"));
      }
      saveBtn.addEventListener("click", (event) => {
        stopPopupEvent(event);
        toggleSaveWord(sourceText, activeTranslation, saveBtn, toastEl, lastSelectionContext);
      });
    });
  }

  } // end if (translatedText !== ERROR_SENTINEL)

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

      const p = renderSpeakableText(sentence, LANG_TTS[sourceLang] || "en-US");

      const speakExBtn = makeButton("translate-row-speak-btn", t("listenPhrase"), speakerSvgSmall());
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
          if (chrome.runtime.lastError) { transBtn.textContent = t("showTranslation"); return; }
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

  if (pinnedPosition) {
    popupEl.classList.add("is-pinned");
    const pinnedTop  = Math.min(Math.max(parseFloat(pinnedPosition.top),  viewportPadding), window.innerHeight - popupRect.height - viewportPadding);
    const pinnedLeft = Math.min(Math.max(parseFloat(pinnedPosition.left), viewportPadding), window.innerWidth  - popupRect.width  - viewportPadding);
    popupEl.style.top  = `${pinnedTop}px`;
    popupEl.style.left = `${pinnedLeft}px`;
  } else if (!isDragged) {
    if (rect) {
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
      popupEl.style.top  = `${top}px`;
      popupEl.style.left = `${left}px`;
      popupEl.dataset.placement = placeAbove ? "top" : "bottom";
    } else {
      const top  = window.scrollY + (window.innerHeight - popupRect.height) / 2;
      const left = window.scrollX + (window.innerWidth  - popupRect.width)  / 2;
      popupEl.style.top  = `${Math.max(top,  window.scrollY + viewportPadding)}px`;
      popupEl.style.left = `${Math.max(left, window.scrollX + viewportPadding)}px`;
    }
  }

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

function renderSpeakableText(htmlStr, lang) {
  const p = document.createElement("p");
  p.className = "translate-example-sentence";

  const temp = document.createElement("div");
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
              span.textContent = part;
              span.addEventListener("mousedown", stopPopupEvent);
              span.addEventListener("click", (e) => {
                stopPopupEvent(e);
                speakText(word, lang);
              });
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
        target.appendChild(node.cloneNode(true));
      }
    }
  }

  wrapWords(temp, p);
  return p;
}

function hidePopup() {
  if (popupEl) {
    popupEl.classList.remove("is-visible");
    popupEl.style.display = "none";
  }
  isDragged = false;
  clearTimeout(hideTimer);
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

function toggleSaveWord(word, translation, saveBtn, toastEl, context) {
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
      const entry = { word, translation, savedAt: Date.now() };
      if (context) entry.context = context;
      list.push(entry);
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

function getContextSentence(word) {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return "";
  const container = sel.getRangeAt(0).commonAncestorContainer;
  const el = container.nodeType === 3 ? container.parentElement : container;
  const block = el.closest("p, li, td, blockquote, article") || el;
  const text = (block.textContent || "").trim().replace(/\s+/g, " ");
  if (!text) return "";
  const idx = text.toLowerCase().indexOf(word.toLowerCase());
  if (idx === -1) return text.slice(0, 280).trim();
  const start = Math.max(0, idx - 100);
  return text.slice(start, start + 280).trim();
}

function looksLikeEnglish(text) {
  if (!text || !text.trim()) return false;

  if (sourceLang === "en") {
    // Permite ASCII + latinos acentuados (café, naïve) + aspas tipográficas ('don't', "quote")
    return !/[^\x00-\x7FÀ-ɏ‘-‟]/.test(text);
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

function pinSvg() {
  return '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 17v5M9 10.5V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v5.5l2 2v1H7v-1l2-2z"/></svg>';
}

function closeSvg() {
  return '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
}

function makeDraggable(el, handleEl) {
  let startX, startY, origLeft, origTop;
  handleEl.style.cursor = "grab";

  handleEl.addEventListener("mousedown", (e) => {
    if (e.target.closest("button")) return;
    startX = e.clientX;
    startY = e.clientY;
    const isFixed = el.classList.contains("is-pinned");
    origLeft = parseInt(el.style.left) || el.getBoundingClientRect().left + (isFixed ? 0 : window.scrollX);
    origTop  = parseInt(el.style.top)  || el.getBoundingClientRect().top  + (isFixed ? 0 : window.scrollY);
    handleEl.style.cursor = "grabbing";

    const onMove = (e) => {
      isDragged = true;
      el.style.left = (origLeft + e.clientX - startX) + "px";
      el.style.top  = (origTop  + e.clientY - startY) + "px";
      if (pinnedPosition) {
        pinnedPosition = { top: el.style.top, left: el.style.left };
      }
    };
    const onUp = () => {
      handleEl.style.cursor = "grab";
      // Persiste posição apenas uma vez, ao soltar — não a cada mousemove
      if (pinnedPosition) {
        chrome.storage.local.set({ pinnedPosition });
      }
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
    e.preventDefault();
  });
}
