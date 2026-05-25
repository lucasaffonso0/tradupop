const uiLangSelect  = document.getElementById("uiLangSelect");

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
  };
  for (const [id, text] of Object.entries(map)) {
    const el = document.getElementById(id);
    if (el) el.textContent = text;
  }
  document.querySelectorAll("[data-i18n]").forEach((el) => {
    const key = el.dataset.i18n;
    if (s[key]) el.textContent = s[key];
  });
  const wordSearch = document.getElementById("wordSearch");
  if (wordSearch) wordSearch.placeholder = s.searchPlaceholder || "";
  document.querySelectorAll(".word-delete").forEach((btn) => {
    btn.title = s.deleteWord || "Remove";
  });
}

const darkToggle    = document.getElementById("darkModeToggle");
const shortcutInput = document.getElementById("shortcutInput");
const saveShortcut  = document.getElementById("saveShortcutBtn");
const feedback      = document.getElementById("shortcutFeedback");
const wordList      = document.getElementById("wordList");
const wordSearch    = document.getElementById("wordSearch");
const emptyState    = document.getElementById("emptyState");
const wordCount     = document.getElementById("wordCount");
const clearAllBtn   = document.getElementById("clearAllBtn");
const exportBtn     = document.getElementById("exportBtn");
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

  renderWordList(Array.isArray(result.savedWords) ? result.savedWords : []);
});

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
  chrome.storage.local.set({
    sourceLang: sourceLangEl.value,
    targetLang: targetLangEl.value
  });
});

// ── Dark mode ──
darkToggle.addEventListener("change", () => {
  const enabled = darkToggle.checked;
  document.body.classList.toggle("dark", enabled);
  chrome.storage.local.set({ darkMode: enabled });
});

// ── Atalho ──
shortcutInput.addEventListener("keydown", (e) => {
  e.preventDefault();
  const key = e.key.replace(/^(Control|Alt|Shift|Meta)$/, "");
  if (key && key.length === 1) {
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
  setTimeout(() => {
    feedback.textContent = "";
    feedback.className = "feedback";
  }, 3000);
}

// ── Busca em tempo real ──
wordSearch.addEventListener("input", () => {
  const q = wordSearch.value.trim().toLowerCase();
  document.querySelectorAll(".word-item").forEach((item) => {
    const text = item.textContent.toLowerCase();
    item.style.display = text.includes(q) ? "" : "none";
  });
});

// ── Lista de palavras salvas ──
function renderWordList(words) {
  wordList.innerHTML = "";
  wordCount.textContent = words.length;
  wordSearch.value = "";

  if (words.length === 0) {
    emptyState.style.display = "block";
    clearAllBtn.style.display = "none";
    exportBtn.style.display = "none";
    wordSearch.style.display = "none";
    return;
  }

  emptyState.style.display = "none";
  clearAllBtn.style.display = "inline-flex";
  exportBtn.style.display = "inline-flex";
  wordSearch.style.display = "block";

  const lang = uiLangSelect.value;
  const s = UI_STRINGS[lang] || UI_STRINGS["pt"];

  const sorted = [...words].sort((a, b) => a.word.localeCompare(b.word));

  for (const entry of sorted) {
    const item = document.createElement("div");
    item.className = "word-item";

    const textWrap = document.createElement("div");
    textWrap.className = "word-item-text";

    const enEl = document.createElement("div");
    enEl.className = "word-en";
    enEl.textContent = entry.word;

    const ptEl = document.createElement("div");
    ptEl.className = "word-pt";
    ptEl.textContent = entry.translation;

    textWrap.appendChild(enEl);
    textWrap.appendChild(ptEl);

    const delBtn = document.createElement("button");
    delBtn.className = "word-delete";
    delBtn.title = s.deleteWord || "Remove";
    delBtn.textContent = "×";
    delBtn.addEventListener("click", () => deleteWord(entry.word));

    item.appendChild(textWrap);
    item.appendChild(delBtn);
    wordList.appendChild(item);
  }
}

function deleteWord(word) {
  chrome.storage.local.get(["savedWords"], (result) => {
    const list = (result.savedWords || []).filter(
      (w) => w.word.toLowerCase() !== word.toLowerCase()
    );
    chrome.storage.local.set({ savedWords: list }, () => {
      renderWordList(list);
    });
  });
}

clearAllBtn.addEventListener("click", () => {
  const lang = uiLangSelect.value;
  const s = UI_STRINGS[lang] || UI_STRINGS["pt"];
  if (!confirm(s.confirmClearAll)) return;
  chrome.storage.local.set({ savedWords: [] }, () => {
    renderWordList([]);
  });
});

// ── Exportar palavras ──
exportBtn.addEventListener("click", () => {
  chrome.storage.local.get(["savedWords"], (result) => {
    const data = JSON.stringify(result.savedWords || [], null, 2);
    const blob = new Blob([data], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "tradupop-words.json";
    a.click();
    URL.revokeObjectURL(url);
  });
});
