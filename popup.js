const uiLangSelect = document.getElementById("uiLangSelect");

function applyUiStrings(lang) {
  const s = UI_STRINGS[lang] || UI_STRINGS["pt"];
  const map = {
    "lbl-panelSubtitle":   s.panelSubtitle,
    "lbl-darkMode":        s.darkMode,
    "lbl-shortcutTitle":   s.shortcutTitle,
    "lbl-langsTitle":      s.langsTitle,
    "lbl-langFrom":        s.langFrom,
    "lbl-langTo":          s.langTo,
    "lbl-savedWordsTitle": s.savedWordsTitle,
    "lbl-uiLang":          s.uiLangTitle,
    "lbl-openVocab":       s.openVocab       || "Abrir",
    "lbl-dueForReview":    s.dueForReview     || "para revisar",
    "lbl-popupModeTitle":  s.popupModeTitle  || "Onde mostrar a tradução",
    "opt-popupModePage":   s.popupModePage   || "Na página",
    "opt-popupModeIcon":   s.popupModeIcon   || "No ícone da extensão",
    "lbl-iconModeHint":    s.iconModeHint    || "",
    "lbl-configureShortcut": s.configureShortcut || "Configurar atalho do navegador",
    "hsMsg":               s.supportHint     || "",
    "hsPixLabel":          s.pixKeyLabel     || "Chave Pix",
    "lbl-hsCopy":          s.copyPix         || "Copiar chave Pix",
    "lbl-hsDonate":        s.donateBtn       || "Fazer uma doação",
    "lbl-supportProject":  s.supportProject  || "Apoiar projeto",
  };
  for (const [id, text] of Object.entries(map)) {
    const el = document.getElementById(id);
    if (el) el.textContent = text;
  }
  const heartBtn = document.getElementById("supportHeartBtn");
  if (heartBtn) {
    heartBtn.title = s.supportTitle || "Apoie o projeto";
    heartBtn.setAttribute("aria-label", heartBtn.title);
  }
  document.querySelectorAll("[data-i18n]").forEach((el) => {
    const key = el.dataset.i18n;
    if (s[key]) el.textContent = s[key];
  });
  applyLangOptions(s.langOptions);
}

function applyLangOptions(opts) {
  if (!opts) return;
  [sourceLangEl, targetLangEl].forEach(select => {
    if (!select) return;
    for (const opt of select.options) {
      if (opts[opt.value]) opt.textContent = opts[opt.value];
    }
  });
}

const darkToggle    = document.getElementById("darkModeToggle");
const shortcutInput = document.getElementById("shortcutInput");
const saveShortcut  = document.getElementById("saveShortcutBtn");
const feedback      = document.getElementById("shortcutFeedback");
const wordCount     = document.getElementById("wordCount");
const openVocabBtn  = document.getElementById("openVocabBtn");
const duePill       = document.getElementById("duePill");
const dueCount      = document.getElementById("dueCount");
const sourceLangEl  = document.getElementById("sourceLang");
const targetLangEl  = document.getElementById("targetLang");
const swapLangBtn   = document.getElementById("swapLangBtn");
const popupModeCards   = document.getElementById("popupModeCards");
const iconModeHintWrap = document.getElementById("iconModeHintWrap");
const openShortcutsBtn = document.getElementById("openShortcutsBtn");
const translationView  = document.getElementById("translationView");
const tvSourceLangEl   = document.getElementById("tvSourceLang");
const tvSourceEl       = document.getElementById("tvSource");
const tvPhoneticEl     = document.getElementById("tvPhonetic");
const tvTargetLangEl   = document.getElementById("tvTargetLang");
const tvTargetEl       = document.getElementById("tvTarget");
const tvAltsEl         = document.getElementById("tvAlts");
const tvDefsEl         = document.getElementById("tvDefs");
const tvToastEl        = document.getElementById("tvToast");
const tvSpeakBtn       = document.getElementById("tvSpeakBtn");
const tvSpeakSlowBtn   = document.getElementById("tvSpeakSlowBtn");
const tvSaveBtn        = document.getElementById("tvSaveBtn");
const tvSettingsBtn    = document.getElementById("tvSettingsBtn");

// ── Carrega configurações ──
chrome.storage.local.get(["darkMode", "shortcutKey", "savedWords", "sourceLang", "targetLang", "uiLang", "popupMode"], (result) => {
  const lang = result.uiLang || "pt";
  uiLangSelect.value = lang;
  applyUiStrings(lang);

  const dark = resolveDarkMode(result.darkMode);
  darkToggle.checked = dark;
  document.body.classList.toggle("dark", dark);

  shortcutInput.value = (result.shortcutKey || "q").toUpperCase();
  if (result.sourceLang) sourceLangEl.value = result.sourceLang;
  if (result.targetLang) targetLangEl.value = result.targetLang;

  setPopupModeUI(result.popupMode || "page");

  updateWordCount(Array.isArray(result.savedWords) ? result.savedWords : []);

  checkPendingSelection();
});

// Atualiza contador quando palavras mudam
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.savedWords) {
    updateWordCount(Array.isArray(changes.savedWords.newValue) ? changes.savedWords.newValue : []);
  }
});

function updateWordCount(words) {
  wordCount.textContent = words.length;
  const now = Date.now();
  const due = words.filter(w => !w.nextReview || w.nextReview <= now).length;
  if (due > 0) {
    dueCount.textContent = due;
    duePill.style.display = "inline-flex";
  } else {
    duePill.style.display = "none";
  }
}

uiLangSelect.addEventListener("change", () => {
  const lang = uiLangSelect.value;
  chrome.storage.local.set({ uiLang: lang });
  applyUiStrings(lang);
});

// ── Idiomas ──
sourceLangEl.addEventListener("change", () => {
  chrome.storage.local.set({ sourceLang: sourceLangEl.value });
});

targetLangEl.addEventListener("change", () => {
  chrome.storage.local.set({ targetLang: targetLangEl.value });
});

swapLangBtn.addEventListener("click", () => {
  const tmp = sourceLangEl.value;
  sourceLangEl.value = targetLangEl.value;
  targetLangEl.value = tmp;
  chrome.storage.local.set({ sourceLang: sourceLangEl.value, targetLang: targetLangEl.value });
});

// ── Dark mode ──
darkToggle.addEventListener("change", () => {
  const enabled = darkToggle.checked;
  document.body.classList.toggle("dark", enabled);
  chrome.storage.local.set({ darkMode: enabled });
});

// ── Atalho ──
shortcutInput.addEventListener("keydown", (e) => {
  const key = e.key.replace(/^(Control|Alt|Shift|Meta)$/, "");
  if (key && key.length === 1 && /\S/.test(key)) {
    e.preventDefault();
    shortcutInput.value = key.toUpperCase();
  }
});

saveShortcut.addEventListener("click", () => {
  const key = shortcutInput.value.trim().toLowerCase();
  if (!key || key.length !== 1 || !/^[a-z0-9]$/.test(key)) {
    const lang = uiLangSelect.value;
    showFeedback((UI_STRINGS[lang] || UI_STRINGS["pt"]).invalidKey, "err");
    return;
  }
  chrome.storage.local.set({ shortcutKey: key }, () => {
    const lang = uiLangSelect.value;
    const s = UI_STRINGS[lang] || UI_STRINGS["pt"];
    showFeedback(s.shortcutSaved + key.toUpperCase(), "ok");
  });
});

function showFeedback(msg, type) {
  feedback.textContent = msg;
  feedback.className = "feedback " + type;
  setTimeout(() => { feedback.textContent = ""; feedback.className = "feedback"; }, 3000);
}

// ── Abre página de vocabulário ──
openVocabBtn.addEventListener("click", () => {
  chrome.tabs.create({ url: chrome.runtime.getURL("vocabulary.html") });
});

// ── Onde mostrar a tradução ──
function setPopupModeUI(value) {
  for (const card of popupModeCards.querySelectorAll(".mode-card")) {
    const active = card.dataset.value === value;
    card.classList.toggle("active", active);
    card.setAttribute("aria-checked", String(active));
  }
  iconModeHintWrap.style.display = value === "icon" ? "" : "none";
}

popupModeCards.addEventListener("click", (e) => {
  const card = e.target.closest(".mode-card");
  if (!card) return;
  chrome.storage.local.set({ popupMode: card.dataset.value });
  setPopupModeUI(card.dataset.value);
});

// Firefox não permite abrir chrome:// nem about:addons via tabs.create —
// lá os atalhos são gerenciados em about:addons → ⚙ → Gerenciar atalhos de extensão
const IS_FIREFOX = typeof browser !== "undefined" && navigator.userAgent.includes("Firefox");
if (IS_FIREFOX) openShortcutsBtn.style.display = "none";

openShortcutsBtn.addEventListener("click", () => {
  chrome.tabs.create({ url: "chrome://extensions/shortcuts" });
});

// ─────────────────────────────────────────────
// ── Modo ícone: tradução da seleção pendente ──
// ─────────────────────────────────────────────

let tvCurrent = null;          // { text, context, sourceLang, targetLang, phonetic, examples }
let tvActiveTranslation = "";

function tvStrings() {
  return UI_STRINGS[uiLangSelect.value] || UI_STRINGS.pt;
}

function checkPendingSelection() {
  chrome.runtime.sendMessage({ type: "GET_PENDING_SELECTION" }, (resp) => {
    if (chrome.runtime.lastError || !resp?.pending?.text) return;
    showTranslationView(resp.pending);
  });
}

function showTranslationView(pending) {
  const s = tvStrings();
  const sl = sourceLangEl.value || "en";
  const tl = targetLangEl.value || "pt";
  tvCurrent = { text: pending.text, context: pending.context || "", sourceLang: sl, targetLang: tl, phonetic: "", examples: [] };
  tvActiveTranslation = "";

  // Aberto por seleção: mostra só a tradução; configurações ficam atrás do ⚙
  document.body.classList.add("translation-only");
  tvSettingsBtn.style.display = "";
  tvSettingsBtn.title = s.settings || "Configurações";
  tvSettingsBtn.setAttribute("aria-label", tvSettingsBtn.title);

  translationView.style.display = "";
  tvSourceLangEl.textContent = LANG_NAMES[sl] || sl;
  tvTargetLangEl.textContent = LANG_NAMES[tl] || tl;
  tvSourceEl.textContent = pending.text;
  tvPhoneticEl.style.display = "none";
  tvAltsEl.style.display = "none";
  tvAltsEl.innerHTML = "";
  tvDefsEl.style.display = "none";
  tvDefsEl.innerHTML = "";
  tvTargetEl.textContent = s.loading;
  tvTargetEl.classList.add("is-loading");
  tvSpeakBtn.title = s.listenIn + " " + (LANG_NAMES[sl] || sl);
  tvSpeakBtn.setAttribute("aria-label", tvSpeakBtn.title);
  tvSpeakSlowBtn.title = s.listenSlow;
  tvSpeakSlowBtn.setAttribute("aria-label", s.listenSlow);
  tvSaveBtn.title = s.saveWord;
  tvSaveBtn.setAttribute("aria-label", s.saveWord);
  tvSaveBtn.classList.remove("is-saved");

  chrome.runtime.sendMessage({ type: "TRANSLATE_TEXT", text: pending.text }, (response) => {
    tvTargetEl.classList.remove("is-loading");
    if (chrome.runtime.lastError || !response?.ok) {
      tvTargetEl.textContent = s.errTranslation;
      return;
    }

    tvActiveTranslation = response.translated;
    tvCurrent.phonetic = response.phonetic || "";
    tvCurrent.examples = (response.examples || []).slice(0, 3).map((x) => x.replace(/<\/?b>/g, "").trim());
    tvTargetEl.textContent = response.translated;

    if (response.phonetic) {
      tvPhoneticEl.textContent = "/" + String(response.phonetic).replace(/^[/\[]+|[/\]]+$/g, "").trim() + "/";
      tvPhoneticEl.style.display = "";
    }

    const alts = Array.isArray(response.alternatives) ? response.alternatives : [];
    if (alts.length > 0) {
      alts.forEach((alt, i) => {
        if (i > 0) tvAltsEl.appendChild(document.createTextNode(" • "));
        const span = document.createElement("span");
        span.className = "tv-alt-word";
        span.textContent = alt;
        span.addEventListener("click", () => {
          tvActiveTranslation = alt;
          tvTargetEl.textContent = alt;
          for (const sib of tvAltsEl.querySelectorAll(".tv-alt-word")) sib.classList.remove("is-active");
          span.classList.add("is-active");
        });
        tvAltsEl.appendChild(span);
      });
      tvAltsEl.style.display = "";
    }

    const defs = Array.isArray(response.definitions) ? response.definitions : [];
    if (defs.length > 0) {
      const title = document.createElement("div");
      title.className = "tv-defs-title";
      title.textContent = s.definitions;
      tvDefsEl.appendChild(title);
      for (const group of defs) {
        if (group.pos) {
          const pos = document.createElement("div");
          pos.className = "tv-def-pos";
          pos.textContent = group.pos;
          tvDefsEl.appendChild(pos);
        }
        for (const d of group.defs || []) {
          const p = document.createElement("p");
          p.className = "tv-def-item";
          p.textContent = d;
          tvDefsEl.appendChild(p);
        }
      }
      tvDefsEl.style.display = "";
    }

    refreshTvSaveState();
  });
}

function refreshTvSaveState() {
  chrome.storage.local.get(["savedWords"], (r) => {
    if (!tvCurrent) return;
    const list = Array.isArray(r.savedWords) ? r.savedWords : [];
    const saved = list.some((w) => w.word.toLowerCase() === tvCurrent.text.toLowerCase());
    tvSaveBtn.classList.toggle("is-saved", saved);
    tvSaveBtn.title = saved ? tvStrings().wordSaved : tvStrings().saveWord;
  });
}

tvSaveBtn.addEventListener("click", () => {
  if (!tvCurrent || !tvActiveTranslation) return;
  const s = tvStrings();
  const key = tvCurrent.text.toLowerCase();
  chrome.storage.local.get(["savedWords"], (r) => {
    let list = Array.isArray(r.savedWords) ? r.savedWords : [];
    const exists = list.some((w) => w.word.toLowerCase() === key);
    if (exists) {
      list = list.filter((w) => w.word.toLowerCase() !== key);
      tvSaveBtn.classList.remove("is-saved");
      showTvToast(s.removed);
    } else {
      const entry = {
        word: tvCurrent.text,
        translation: tvActiveTranslation,
        savedAt: Date.now(),
        sourceLang: tvCurrent.sourceLang,
        targetLang: tvCurrent.targetLang,
      };
      if (tvCurrent.context) entry.context = tvCurrent.context;
      if (tvCurrent.phonetic) entry.phonetic = tvCurrent.phonetic;
      if (tvCurrent.examples.length > 0) entry.examples = tvCurrent.examples;
      list.push(entry);
      tvSaveBtn.classList.add("is-saved");
      showTvToast(s.saved);
    }
    chrome.storage.local.set({ savedWords: list });
  });
});

function tvSpeak(slow) {
  if (!tvCurrent) return;
  const ttsLang = LANG_TTS[tvCurrent.sourceLang] || "en-US";
  if (slow) {
    if (!("speechSynthesis" in window)) return;
    window.speechSynthesis.cancel();
    const utt = new SpeechSynthesisUtterance(tvCurrent.text);
    utt.lang = ttsLang;
    utt.rate = 0.55;
    window.speechSynthesis.speak(utt);
    return;
  }
  // Mesma URL do popup in-page (client=tw-ob é o endpoint que funciona sem token)
  const url = new URL("https://translate.google.com/translate_tts");
  url.searchParams.set("ie", "UTF-8");
  url.searchParams.set("tl", ttsLang);
  url.searchParams.set("client", "tw-ob");
  url.searchParams.set("q", tvCurrent.text);
  url.searchParams.set("total", "1");
  url.searchParams.set("idx", "0");
  url.searchParams.set("textlen", String(tvCurrent.text.length));
  const audio = new Audio(url.toString());
  audio.play().catch(() => {
    if (!("speechSynthesis" in window)) return;
    window.speechSynthesis.cancel();
    const utt = new SpeechSynthesisUtterance(tvCurrent.text);
    utt.lang = ttsLang;
    utt.rate = 0.95;
    window.speechSynthesis.speak(utt);
  });
}

tvSpeakBtn.addEventListener("click", () => tvSpeak(false));
tvSpeakSlowBtn.addEventListener("click", () => tvSpeak(true));

// O popup rouba o foco da página ao abrir, então o atalho Ctrl+<tecla>
// de falar a seleção precisa funcionar aqui dentro também
document.addEventListener("keydown", (e) => {
  if (!tvCurrent) return;
  const key = (shortcutInput.value || "q").trim().toLowerCase();
  if (e.ctrlKey && e.key.toLowerCase() === key) {
    e.preventDefault();
    tvSpeak(false);
  }
});

// ⚙ na view de tradução: revela as configurações abaixo da tradução
tvSettingsBtn.addEventListener("click", () => {
  document.body.classList.remove("translation-only");
  tvSettingsBtn.style.display = "none";
});

// ─────────────────────────────────────────────
// ── Apoie o projeto (config em ui-strings.js: DONATION) ──
// ─────────────────────────────────────────────

const supportHeartBtn   = document.getElementById("supportHeartBtn");
const headerSupportCard = document.getElementById("headerSupportCard");
const hsPixKey          = document.getElementById("hsPixKey");
const hsCopyBtn         = document.getElementById("hsCopyBtn");
const hsFeedback        = document.getElementById("hsFeedback");
const hsDonateBtn       = document.getElementById("hsDonateBtn");

(function initSupport() {
  const hasUrl = typeof DONATION !== "undefined" && !!DONATION.url;
  const hasPix = typeof DONATION !== "undefined" && !!DONATION.pixKey;
  if (!hasUrl && !hasPix) return;
  supportHeartBtn.style.display = "";
  if (hasPix) hsPixKey.textContent = DONATION.pixKey;
  else {
    hsPixKey.style.display = "none";
    hsCopyBtn.style.display = "none";
    document.getElementById("hsPixLabel").style.display = "none";
  }
  if (hasUrl) hsDonateBtn.style.display = "";
})();

supportHeartBtn.addEventListener("click", () => {
  const open = headerSupportCard.style.display !== "none";
  headerSupportCard.style.display = open ? "none" : "";
  supportHeartBtn.classList.toggle("is-active", !open);
});

let pixFeedbackTimer = null;
hsCopyBtn.addEventListener("click", () => {
  navigator.clipboard.writeText(DONATION.pixKey).then(() => {
    hsFeedback.textContent = tvStrings().pixCopied || "Chave Pix copiada!";
    clearTimeout(pixFeedbackTimer);
    pixFeedbackTimer = setTimeout(() => { hsFeedback.textContent = ""; }, 2500);
  }).catch(() => { });
});

hsDonateBtn.addEventListener("click", () => {
  chrome.tabs.create({ url: DONATION.url });
});

let tvToastTimer = null;
function showTvToast(msg) {
  tvToastEl.textContent = msg;
  tvToastEl.classList.add("is-visible");
  clearTimeout(tvToastTimer);
  tvToastTimer = setTimeout(() => tvToastEl.classList.remove("is-visible"), 2000);
}
