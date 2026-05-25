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
  };
  for (const [id, text] of Object.entries(map)) {
    const el = document.getElementById(id);
    if (el) el.textContent = text;
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

// ── Carrega configurações ──
chrome.storage.local.get(["darkMode", "shortcutKey", "savedWords", "sourceLang", "targetLang", "uiLang"], (result) => {
  const lang = result.uiLang || "pt";
  uiLangSelect.value = lang;
  applyUiStrings(lang);

  if (result.darkMode) {
    darkToggle.checked = true;
    document.body.classList.add("dark");
  }

  shortcutInput.value = (result.shortcutKey || "q").toUpperCase();
  if (result.sourceLang) sourceLangEl.value = result.sourceLang;
  if (result.targetLang) targetLangEl.value = result.targetLang;

  updateWordCount(Array.isArray(result.savedWords) ? result.savedWords : []);
});

// Atualiza contador quando palavras mudam
chrome.storage.onChanged.addListener((changes) => {
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
