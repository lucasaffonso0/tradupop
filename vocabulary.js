// ── Internacionalização ──
let uiLang = "pt";
function s(key) { return (UI_STRINGS[uiLang] || UI_STRINGS["pt"])[key] || key; }

// ── Estado ──
let allWords = [];
let toastHideTimer = null;
let localWrite = false; // suprime echo do onChanged para escritas locais

// ── Spaced repetition ──
const REVIEW_INTERVALS = [0, 1, 3, 7, 14, 30].map(d => d * 86400000);

function getDueWords(words) {
  const now = Date.now();
  return words.filter(w => !w.nextReview || w.nextReview <= now);
}

function getMasteredWords(words) {
  return words.filter(w => (w.reviewLevel || 0) >= 5);
}

function updateReviewLevel(word, knew) {
  // Lapso suave: errar desce 1 nível em vez de zerar todo o progresso
  const level = knew
    ? Math.min((word.reviewLevel || 0) + 1, 5)
    : Math.max(0, (word.reviewLevel || 0) - 1);
  return { ...word, reviewLevel: level, nextReview: Date.now() + REVIEW_INTERVALS[level] };
}

// Fisher-Yates — sort(() => Math.random() - 0.5) não gera permutação uniforme
function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function formatPhonetic(phonetic) {
  return `/${String(phonetic).replace(/^[/\[]+|[/\]]+$/g, "").trim()}/`;
}

// LANG_TTS e LANG_NAMES são globais definidos em ui-strings.js
let sourceLang = "en";
let targetLang = "pt";
let practiceDirection = "forward"; // forward | reverse | mixed
let sortMode = "alpha";            // alpha | recent | level | due
let darkModeExplicit = false;

function speakWord(word, slow = false, lang) {
  const ttsLang = LANG_TTS[lang || sourceLang] || "en-US";
  if (slow) {
    if (!("speechSynthesis" in window)) return;
    window.speechSynthesis.cancel();
    const utt = new SpeechSynthesisUtterance(word);
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
  url.searchParams.set("q", word);
  url.searchParams.set("total", "1");
  url.searchParams.set("idx", "0");
  url.searchParams.set("textlen", String(word.length));
  const audio = new Audio(url.toString());
  audio.play().catch(() => {
    const utt = new SpeechSynthesisUtterance(word);
    utt.lang = ttsLang;
    utt.rate = 0.95;
    window.speechSynthesis.speak(utt);
  });
}

// ── Elementos DOM ──
const app           = document.getElementById("app");
const darkToggle    = document.getElementById("darkToggle");
const tabList       = document.getElementById("tabList");
const tabPractice   = document.getElementById("tabPractice");
const viewList      = document.getElementById("viewList");
const viewPractice  = document.getElementById("viewPractice");
const wordList      = document.getElementById("wordList");
const emptyState    = document.getElementById("emptyState");
const wordSearch    = document.getElementById("wordSearch");
const sortSelect    = document.getElementById("sortSelect");
const importBtn     = document.getElementById("importBtn");
const importFile    = document.getElementById("importFile");
const exportBtn     = document.getElementById("exportBtn");
const clearAllBtn   = document.getElementById("clearAllBtn");
const importFeedback = document.getElementById("importFeedback");
const undoToast     = document.getElementById("undoToast");
const undoMsg       = document.getElementById("undoMsg");
const undoBtn       = document.getElementById("undoBtn");
const practiceContent = document.getElementById("practiceContent");
const statTotal     = document.getElementById("statTotal");
const statDue       = document.getElementById("statDue");
const statMastered  = document.getElementById("statMastered");
const dueBadge      = document.getElementById("dueBadge");

// ── Init ──
chrome.storage.local.get(["savedWords", "darkMode", "uiLang", "sourceLang", "targetLang", "practiceDirection", "vocabSort"], (result) => {
  uiLang = result.uiLang || "pt";
  sourceLang = result.sourceLang || "en";
  targetLang = result.targetLang || "pt";
  practiceDirection = result.practiceDirection || "forward";
  sortMode = result.vocabSort || "alpha";
  sortSelect.value = sortMode;
  applyStrings();

  const dark = resolveDarkMode(result.darkMode);
  darkModeExplicit = result.darkMode !== undefined;
  darkToggle.checked = dark;
  document.body.classList.toggle("dark", dark);

  allWords = Array.isArray(result.savedWords) ? result.savedWords : [];
  renderList();
  updateStats();
});

// Segue o tema do sistema enquanto o usuário não escolher manualmente
if (window.matchMedia) {
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", (event) => {
    if (darkModeExplicit) return;
    darkToggle.checked = event.matches;
    document.body.classList.toggle("dark", event.matches);
  });
}

// Sincroniza mudanças feitas em outra aba/popup
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.savedWords) {
    // Ignora echo de escritas locais para não destruir estado de undo em progresso
    if (!localWrite) {
      allWords = Array.isArray(changes.savedWords.newValue) ? changes.savedWords.newValue : [];
      renderList(wordSearch.value.trim().toLowerCase() || undefined);
      updateStats();
    }
  }
  if (changes.darkMode) {
    darkModeExplicit = changes.darkMode.newValue !== undefined;
    const dark = resolveDarkMode(changes.darkMode.newValue);
    darkToggle.checked = dark;
    document.body.classList.toggle("dark", dark);
  }
  if (changes.uiLang) {
    uiLang = changes.uiLang.newValue || "pt";
    applyStrings();
  }
  if (changes.sourceLang) {
    sourceLang = changes.sourceLang.newValue || "en";
  }
  if (changes.targetLang) {
    targetLang = changes.targetLang.newValue || "pt";
  }
  if (changes.vocabSort && changes.vocabSort.newValue !== sortMode) {
    sortMode = changes.vocabSort.newValue || "alpha";
    sortSelect.value = sortMode;
    renderList(wordSearch.value.trim().toLowerCase() || undefined);
  }
  if (changes.practiceDirection) {
    practiceDirection = changes.practiceDirection.newValue || "forward";
  }
});

// ── Strings ──
function applyStrings() {
  const map = {
    "lbl-vocabTitle":     s("vocabTitle")     || "Vocabulário",
    "lbl-statWords":      s("statWords")      || "palavras",
    "lbl-statDue":        s("dueForReview")   || "para revisar",
    "lbl-statMastered":   s("statMastered")   || "dominadas",
    "lbl-tabList":        s("tabList")        || "Lista",
    "lbl-tabPractice":    s("tabPractice")    || "Praticar",
    "lbl-import":         s("import")         || "Importar",
    "lbl-export":         s("export")         || "Exportar",
    "lbl-clearAll":       s("clearAll")       || "Limpar tudo",
    "lbl-noWords":        s("noWords")        || "Nenhuma palavra salva ainda.",
    "lbl-noWordsHint":    s("noWordsHint")    || "Selecione palavras nas páginas e clique ★ para salvar.",
    "lbl-sortAlpha":      s("sortAlpha")      || "A–Z",
    "lbl-sortRecent":     s("sortRecent")     || "Mais recentes",
    "lbl-sortLevel":      s("sortLevel")      || "Por nível",
    "lbl-sortDueFirst":   s("sortDueFirst")   || "A revisar primeiro",
    "lbl-supportFooter":  s("supportTitle")   || "Apoie o projeto",
    "lbl-supportBtn":     s("supportBtn")     || "Apoiar",
    "supportModalTitle":  s("supportTitle")   || "Apoie o projeto",
    "supportModalHint":   s("supportHint")    || "",
    "supportPixLabel":    s("pixKeyLabel")    || "Chave Pix",
    "lbl-modalCopyPix":   s("copyPix")        || "Copiar chave Pix",
    "lbl-modalDonate":    s("donateBtn")      || "Fazer uma doação",
    "supportModalThanks": s("supportThanks")  || "",
  };
  for (const [id, text] of Object.entries(map)) {
    const el = document.getElementById(id);
    if (el) el.textContent = text;
  }
  wordSearch.placeholder = s("searchPlaceholder") || "Buscar palavra...";
  undoBtn.textContent = s("undo") || "Desfazer";
  const modalClose = document.getElementById("supportModalClose");
  if (modalClose) modalClose.setAttribute("aria-label", s("close") || "Fechar");
}

// ── Apoie o projeto (config em ui-strings.js: DONATION) ──
const supportFooter    = document.getElementById("supportFooter");
const supportLink      = document.getElementById("supportLink");
const supportHeaderBtn = document.getElementById("supportHeaderBtn");
const supportOverlay   = document.getElementById("supportOverlay");
const supportModalClose = document.getElementById("supportModalClose");
const supportPixBox    = document.getElementById("supportPixBox");
const supportPixKey    = document.getElementById("supportPixKey");
const modalCopyPixBtn  = document.getElementById("modalCopyPixBtn");
const modalPixFeedback = document.getElementById("modalPixFeedback");
const modalDonateBtn   = document.getElementById("modalDonateBtn");

const donationConfigured = typeof DONATION !== "undefined" && !!(DONATION.url || DONATION.pixKey);

function openSupportModal() {
  if (!donationConfigured) return;
  if (DONATION.pixKey) {
    supportPixKey.textContent = DONATION.pixKey;
    supportPixBox.style.display = "";
  }
  if (DONATION.url) modalDonateBtn.style.display = "";
  modalPixFeedback.textContent = "";
  supportOverlay.style.display = "";
  supportModalClose.focus();
}

function closeSupportModal() {
  supportOverlay.style.display = "none";
}

if (donationConfigured) {
  supportHeaderBtn.style.display = "";
  supportFooter.style.display = "";
  supportHeaderBtn.addEventListener("click", openSupportModal);
  supportLink.addEventListener("click", openSupportModal);
  supportModalClose.addEventListener("click", closeSupportModal);
  supportOverlay.addEventListener("click", (e) => {
    if (e.target === supportOverlay) closeSupportModal();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && supportOverlay.style.display !== "none") closeSupportModal();
  });

  let pixFeedbackTimer = null;
  modalCopyPixBtn.addEventListener("click", () => {
    navigator.clipboard.writeText(DONATION.pixKey).then(() => {
      modalPixFeedback.textContent = s("pixCopied") || "Chave Pix copiada!";
      clearTimeout(pixFeedbackTimer);
      pixFeedbackTimer = setTimeout(() => { modalPixFeedback.textContent = ""; }, 2500);
    }).catch(() => { });
  });

  modalDonateBtn.addEventListener("click", () => {
    window.open(DONATION.url, "_blank");
  });
}

// ── Dark mode ──
darkToggle.addEventListener("change", () => {
  const enabled = darkToggle.checked;
  document.body.classList.toggle("dark", enabled);
  chrome.storage.local.set({ darkMode: enabled });
});

// ── Tabs ──
function switchTab(tab) {
  const isListTab = tab === "list";
  viewList.style.display     = isListTab ? "" : "none";
  viewPractice.style.display = isListTab ? "none" : "";
  tabList.classList.toggle("tab--active",     isListTab);
  tabPractice.classList.toggle("tab--active", !isListTab);
  if (!isListTab) renderPracticeStart();
}

tabList.addEventListener("click",     () => switchTab("list"));
tabPractice.addEventListener("click", () => switchTab("practice"));

// ── Stats ──
function updateStats() {
  const due      = getDueWords(allWords).length;
  const mastered = getMasteredWords(allWords).length;
  statTotal.textContent    = allWords.length;
  statDue.textContent      = due;
  statMastered.textContent = mastered;
  dueBadge.textContent     = due;
  dueBadge.style.display   = due > 0 ? "" : "none";
}

// ── Lista ──
function sortWords(words) {
  const list = [...words];
  switch (sortMode) {
    case "recent":
      return list.sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0));
    case "level":
      return list.sort((a, b) =>
        (a.reviewLevel || 0) - (b.reviewLevel || 0) || a.word.localeCompare(b.word));
    case "due":
      // Sem nextReview = nunca revisada = primeiro
      return list.sort((a, b) => (a.nextReview || 0) - (b.nextReview || 0));
    default:
      return list.sort((a, b) => a.word.localeCompare(b.word));
  }
}

function renderList(filter) {
  wordList.innerHTML = "";
  const words = filter
    ? allWords.filter(w =>
        w.word.toLowerCase().includes(filter) ||
        w.translation.toLowerCase().includes(filter))
    : allWords;

  const sorted = sortWords(words);

  if (sorted.length === 0) {
    emptyState.style.display = "";
    return;
  }
  emptyState.style.display = "none";

  for (const entry of sorted) {
    const level = entry.reviewLevel || 0;
    const item = document.createElement("div");
    item.className = "word-item";
    item.dataset.level = level;

    // Dots (5 dots indicating review level)
    const dots = document.createElement("div");
    dots.className = "level-dots";
    for (let i = 0; i < 5; i++) {
      const dot = document.createElement("div");
      dot.className = "level-dot" + (i < level ? " filled" : "");
      dots.appendChild(dot);
    }

    // Body
    const body = document.createElement("div");
    body.className = "word-body";

    const row = document.createElement("div");
    row.className = "word-row";

    const orig = document.createElement("span");
    orig.className = "word-original";
    orig.textContent = entry.word;

    const sep = document.createElement("span");
    sep.className = "word-sep";
    sep.textContent = "→";

    const transl = document.createElement("span");
    transl.className = "word-translation";
    transl.textContent = entry.translation;

    row.appendChild(orig);
    if (entry.phonetic) {
      const phon = document.createElement("span");
      phon.className = "word-phonetic";
      phon.textContent = formatPhonetic(entry.phonetic);
      row.appendChild(phon);
    }
    row.appendChild(sep);
    row.appendChild(transl);
    body.appendChild(row);

    if (entry.context) {
      const ctx = document.createElement("div");
      ctx.className = "word-context";
      ctx.textContent = entry.context;
      body.appendChild(ctx);
    }

    // Actions
    const actions = document.createElement("div");
    actions.className = "word-actions";

    // Speak btn (normal) — usa o idioma salvo com a palavra quando existir
    const entryLang = entry.sourceLang || sourceLang;
    const speakBtn = document.createElement("button");
    speakBtn.className = "word-action-btn";
    speakBtn.title = s("listenIn") + " " + (LANG_NAMES[entryLang] || entryLang);
    speakBtn.innerHTML = `<svg viewBox="0 0 24 24"><path d="M11 5L6 9H2v6h4l5 4V5z"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"/></svg>`;
    speakBtn.addEventListener("click", (e) => { e.stopPropagation(); speakWord(entry.word, false, entryLang); });

    // Speak btn (slow)
    const speakSlowBtn = document.createElement("button");
    speakSlowBtn.className = "word-action-btn slow";
    speakSlowBtn.title = s("listenSlow") || "Ouvir devagar";
    speakSlowBtn.innerHTML = `<svg viewBox="0 0 24 24"><path d="M11 5L6 9H2v6h4l5 4V5z"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/></svg>`;
    speakSlowBtn.addEventListener("click", (e) => { e.stopPropagation(); speakWord(entry.word, true, entryLang); });

    // Delete btn
    const delBtn = document.createElement("button");
    delBtn.className = "word-action-btn delete";
    delBtn.title = s("deleteWord") || "Remover";
    delBtn.innerHTML = `<svg viewBox="0 0 24 24"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`;
    delBtn.addEventListener("click", (e) => { e.stopPropagation(); deleteWord(entry.word); });

    actions.appendChild(speakBtn);
    actions.appendChild(speakSlowBtn);
    actions.appendChild(delBtn);

    item.appendChild(dots);
    item.appendChild(body);
    item.appendChild(actions);
    wordList.appendChild(item);
  }

  updateStats();
}

// ── Busca (debounced) ──
let searchDebounce = null;
wordSearch.addEventListener("input", () => {
  clearTimeout(searchDebounce);
  searchDebounce = setTimeout(() => {
    renderList(wordSearch.value.trim().toLowerCase() || undefined);
  }, 150);
});

// ── Ordenação ──
sortSelect.addEventListener("change", () => {
  sortMode = sortSelect.value;
  chrome.storage.local.set({ vocabSort: sortMode });
  renderList(wordSearch.value.trim().toLowerCase() || undefined);
});

// ── Delete com Undo ──
// Commit imediato no storage: uma escrita adiada abria janela de 5s em que
// gravações de outras abas ressuscitavam a palavra ou eram engolidas pelo timer.
// O Undo reinsere apenas a palavra apagada sobre o estado atual (não um snapshot).
function deleteWord(word) {
  const q = wordSearch.value.trim().toLowerCase() || undefined;
  clearTimeout(toastHideTimer);

  const key = word.toLowerCase();
  const deletedEntry = allWords.find(w => w.word.toLowerCase() === key);
  if (!deletedEntry) return;

  allWords = allWords.filter(w => w.word.toLowerCase() !== key);
  localWrite = true;
  chrome.storage.local.set({ savedWords: allWords }, () => { localWrite = false; });
  renderList(q);
  updateStats();

  undoMsg.textContent = `"${word}" ${s("wordRemoved") || "removida."}`;
  undoToast.style.display = "flex";

  // Sobrescreve handler anterior de forma segura
  undoBtn.onclick = () => {
    clearTimeout(toastHideTimer);
    undoToast.style.display = "none";
    if (!allWords.some(w => w.word.toLowerCase() === key)) {
      allWords = [...allWords, deletedEntry];
      localWrite = true;
      chrome.storage.local.set({ savedWords: allWords }, () => { localWrite = false; });
    }
    renderList(wordSearch.value.trim().toLowerCase() || undefined);
    updateStats();
  };

  toastHideTimer = setTimeout(() => {
    undoToast.style.display = "none";
  }, 5000);
}

// ── Clear all ──
clearAllBtn.addEventListener("click", () => {
  if (!confirm(s("confirmClearAll"))) return;
  // Cancela undo pendente: desfazer após limpar tudo divergiria UI e storage
  clearTimeout(toastHideTimer);
  undoToast.style.display = "none";
  allWords = [];
  localWrite = true;
  chrome.storage.local.set({ savedWords: [] }, () => { localWrite = false; });
  renderList();
  updateStats();
});

// ── Export ──
exportBtn.addEventListener("click", () => {
  const data = JSON.stringify(allWords, null, 2);
  const blob = new Blob([data], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "tradupop-words.json";
  a.click();
  URL.revokeObjectURL(url);
});

// ── Import ──
importBtn.addEventListener("click", () => importFile.click());

importFile.addEventListener("change", () => {
  const file = importFile.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (e) => {
    try {
      const incoming = JSON.parse(e.target.result);
      if (!Array.isArray(incoming)) throw new Error();
      const valid = incoming.filter(w => w && typeof w.word === "string" && typeof w.translation === "string");
      const existingKeys = new Set(allWords.map(w => w.word.toLowerCase()));
      const newWords = valid.filter(w => !existingKeys.has(w.word.toLowerCase()));
      allWords = [...allWords, ...newWords];
      localWrite = true;
      chrome.storage.local.set({ savedWords: allWords }, () => { localWrite = false; });
      renderList(wordSearch.value.trim().toLowerCase() || undefined);
      updateStats();
      if (newWords.length === 0) {
        showImportFeedback(s("importNone"), "ok");
      } else {
        showImportFeedback((s("importSuccess") || "{n} palavras importadas.").replace("{n}", newWords.length), "ok");
      }
    } catch {
      showImportFeedback(s("importError"), "err");
    }
    importFile.value = "";
  };
  reader.readAsText(file);
});

function showImportFeedback(msg, type) {
  importFeedback.textContent = msg;
  importFeedback.className = `import-feedback ${type}`;
  importFeedback.style.display = "block";
  setTimeout(() => { importFeedback.style.display = "none"; }, 3000);
}

// ─────────────────────────────────────────────
// ── MODO PRATICAR ──
// ─────────────────────────────────────────────

function renderPracticeStart() {
  const due = getDueWords(allWords);

  if (allWords.length < 3) {
    practiceContent.innerHTML = "";
    const empty = document.createElement("div");
    empty.className = "practice-empty";
    // Com 1-2 palavras, diz quantas faltam em vez de "nenhuma palavra salva"
    const emptyTitle = allWords.length === 0
      ? (s("noWords") || "Nenhuma palavra salva.")
      : (s("practiceMinWords") || "Salve pelo menos 3 palavras para praticar. Você tem {n}.").replace("{n}", allWords.length);
    empty.innerHTML = `
      <div class="practice-empty-icon">📚</div>
      <div class="practice-empty-title">${emptyTitle}</div>
      <div class="practice-empty-sub">${s("noWordsHint") || "Selecione palavras nas páginas e clique ★ para salvar."}</div>
    `;
    practiceContent.appendChild(empty);
    return;
  }

  practiceContent.innerHTML = "";
  const start = document.createElement("div");
  start.className = "practice-start";

  const title = document.createElement("div");
  title.className = "practice-start-title";
  title.textContent = s("practice") || "Praticar";

  const sub = document.createElement("div");
  sub.className = "practice-start-sub";
  sub.textContent = s("practiceHint") || "Escolha um modo de estudo:";

  // Seletor de direção dos cards (palavra→tradução / tradução→palavra / misto)
  const dirWrap = document.createElement("div");
  dirWrap.className = "practice-direction";

  const dirLabel = document.createElement("span");
  dirLabel.className = "practice-direction-label";
  dirLabel.textContent = s("directionLabel") || "Direção dos cards";
  dirWrap.appendChild(dirLabel);

  const dirBtns = document.createElement("div");
  dirBtns.className = "practice-direction-btns";
  for (const [value, key] of [["forward", "dirForward"], ["reverse", "dirReverse"], ["mixed", "dirMixed"]]) {
    const btn = document.createElement("button");
    btn.className = "btn-direction" + (practiceDirection === value ? " active" : "");
    btn.textContent = s(key) || value;
    btn.addEventListener("click", () => {
      practiceDirection = value;
      chrome.storage.local.set({ practiceDirection: value });
      for (const sib of dirBtns.children) sib.classList.remove("active");
      btn.classList.add("active");
    });
    dirBtns.appendChild(btn);
  }
  dirWrap.appendChild(dirBtns);

  const modes = document.createElement("div");
  modes.className = "practice-modes";

  // Modo 1: Revisão (palavras para revisar hoje)
  if (due.length > 0) {
    const modeReview = document.createElement("button");
    modeReview.className = "btn-practice-mode";
    modeReview.innerHTML = `
      <span class="mode-icon">🔥</span>
      <span class="mode-text">
        <span class="mode-title">${s("reviewDue") || "Revisar agendadas"}</span>
        <span class="mode-sub">${s("reviewDueSub") || "Palavras com revisão pendente"}</span>
      </span>
      <span class="mode-badge">${due.length}</span>
    `;
    modeReview.addEventListener("click", () => startSession(shuffle(due)));
    modes.appendChild(modeReview);
  } else {
    const allDone = document.createElement("div");
    allDone.className = "practice-all-done";
    allDone.textContent = s("allReviewedToday") || "Tudo revisado por hoje 🎉";
    modes.appendChild(allDone);
  }

  // Modo 2: Todas as palavras
  const modeAll = document.createElement("button");
  modeAll.className = "btn-practice-mode";
  modeAll.innerHTML = `
    <span class="mode-icon">⚡</span>
    <span class="mode-text">
      <span class="mode-title">${s("reviewAll") || "Revisar tudo"}</span>
      <span class="mode-sub">${(s("reviewAllSub") || "Todas as {n} palavras salvas").replace("{n}", allWords.length)}</span>
    </span>
  `;
  modeAll.addEventListener("click", () => startSession(shuffle(allWords)));
  modes.appendChild(modeAll);

  start.appendChild(title);
  start.appendChild(sub);
  start.appendChild(dirWrap);
  start.appendChild(modes);
  practiceContent.appendChild(start);
}

function saveSessionProgress(sessionWords) {
  // Mescla apenas os campos de revisão praticados, preservando adições/deleções feitas em outras abas
  chrome.storage.local.get(["savedWords"], (result) => {
    const current = Array.isArray(result.savedWords) ? result.savedWords : allWords;
    const sessionMap = new Map(sessionWords.map(w => [w.word.toLowerCase(), w]));
    const merged = current.map(w => {
      const practiced = sessionMap.get(w.word.toLowerCase());
      return practiced ? { ...w, reviewLevel: practiced.reviewLevel, nextReview: practiced.nextReview } : w;
    });
    allWords = merged;
    localWrite = true;
    chrome.storage.local.set({ savedWords: merged }, () => { localWrite = false; });
    updateStats();
  });
}

function startSession(queue) {
  let idx = 0;
  let correct = 0;
  let wrong = 0;
  // Semeia só com a fila praticada: semear com allWords fazia o merge final
  // sobrescrever reviewLevel/nextReview de TODAS as palavras com o snapshot
  // do início da sessão, revertendo progresso feito em outra aba.
  let sessionWords = [...queue];

  function showCard() {
    practiceContent.innerHTML = "";

    if (idx >= queue.length) {
      saveSessionProgress(sessionWords);
      showComplete();
      return;
    }

    const entry = queue[idx];
    const pct = Math.round((idx / queue.length) * 100);

    // Direção do card: reverso testa produção (tradução → palavra)
    const reverse = practiceDirection === "reverse" ||
      (practiceDirection === "mixed" && Math.random() < 0.5);
    const entrySourceLang = entry.sourceLang || sourceLang;
    const entryTargetLang = entry.targetLang || targetLang;
    const hasCloze = !!(entry.context &&
      new RegExp(escapeRegExp(entry.word), "i").test(entry.context));

    // Header de progresso
    const hdr = document.createElement("div");
    hdr.className = "session-header";
    hdr.innerHTML = `
      <div class="session-progress-wrap">
        <div class="session-progress-label">${idx + 1} / ${queue.length}</div>
        <div class="session-progress-bar">
          <div class="session-progress-fill" style="width:${pct}%"></div>
        </div>
      </div>
    `;
    const endBtn = document.createElement("button");
    endBtn.className = "btn-end-session";
    endBtn.textContent = s("close") || "Encerrar";
    endBtn.addEventListener("click", () => {
      saveSessionProgress(sessionWords);
      renderPracticeStart();
    });
    hdr.appendChild(endBtn);

    // Card
    const card = document.createElement("div");
    card.className = "flashcard";

    // Lang tag — idioma do que está visível no front do card
    const langTag = document.createElement("span");
    langTag.className = "flashcard-lang";
    langTag.textContent = reverse
      ? (LANG_NAMES[entryTargetLang] || entryTargetLang)
      : (LANG_NAMES[entrySourceLang] || entrySourceLang);
    card.appendChild(langTag);

    // Speak buttons — no card reverso ficam ocultos até revelar (o áudio entrega a resposta)
    const speakBtns = document.createElement("div");
    speakBtns.className = "flashcard-speak-group";
    if (reverse) speakBtns.style.display = "none";

    const speakBtn = document.createElement("button");
    speakBtn.className = "flashcard-speak";
    speakBtn.title = (s("listenIn") + " " + (LANG_NAMES[entrySourceLang] || entrySourceLang));
    speakBtn.innerHTML = `<svg viewBox="0 0 24 24"><path d="M11 5L6 9H2v6h4l5 4V5z"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"/></svg>`;
    speakBtn.addEventListener("click", () => speakWord(entry.word, false, entrySourceLang));

    const speakSlowBtn = document.createElement("button");
    speakSlowBtn.className = "flashcard-speak slow";
    speakSlowBtn.title = s("listenSlow") || "Ouvir devagar";
    speakSlowBtn.innerHTML = `<svg viewBox="0 0 24 24"><path d="M11 5L6 9H2v6h4l5 4V5z"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/></svg>`;
    speakSlowBtn.addEventListener("click", () => speakWord(entry.word, true, entrySourceLang));

    speakBtns.appendChild(speakBtn);
    speakBtns.appendChild(speakSlowBtn);
    card.appendChild(speakBtns);

    const wordEl = document.createElement("div");
    wordEl.className = "flashcard-word";
    wordEl.textContent = reverse ? entry.translation : entry.word;
    card.appendChild(wordEl);

    if (!reverse && entry.phonetic) {
      const phonEl = document.createElement("div");
      phonEl.className = "flashcard-phonetic";
      phonEl.textContent = formatPhonetic(entry.phonetic);
      card.appendChild(phonEl);
    }

    // Cloze: no card reverso a frase de contexto aparece com a palavra em lacuna
    let clozeEl = null;
    if (reverse && hasCloze) {
      clozeEl = document.createElement("div");
      clozeEl.className = "flashcard-cloze";
      clozeEl.textContent = entry.context.replace(
        new RegExp(escapeRegExp(entry.word), "gi"), "____");
      card.appendChild(clozeEl);
    }

    const divider = document.createElement("div");
    divider.className = "flashcard-divider";
    card.appendChild(divider);

    const translEl = document.createElement("div");
    translEl.className = "flashcard-translation";
    card.appendChild(translEl);

    // Reveal section
    const revealWrap = document.createElement("div");
    revealWrap.className = "flashcard-reveal";

    const revealBtn = document.createElement("button");
    revealBtn.className = "btn-reveal";
    revealBtn.textContent = s("reveal") || "Revelar";
    revealWrap.appendChild(revealBtn);

    const rateWrap = document.createElement("div");
    rateWrap.className = "flashcard-rate";
    rateWrap.style.display = "none";

    const unknownBtn = document.createElement("button");
    unknownBtn.className = "btn-rate btn-unknown";
    unknownBtn.textContent = s("didntKnow") || "Não sabia ✗";
    unknownBtn.addEventListener("click", () => {
      const updated = updateReviewLevel(entry, false);
      sessionWords = sessionWords.map(w =>
        w.word.toLowerCase() === entry.word.toLowerCase() ? updated : w
      );
      wrong++;
      idx++;
      showCard();
    });

    const knewBtn = document.createElement("button");
    knewBtn.className = "btn-rate btn-knew";
    knewBtn.textContent = s("knew") || "Sabia ✓";
    knewBtn.addEventListener("click", () => {
      const updated = updateReviewLevel(entry, true);
      sessionWords = sessionWords.map(w =>
        w.word.toLowerCase() === entry.word.toLowerCase() ? updated : w
      );
      correct++;
      idx++;
      showCard();
    });

    rateWrap.appendChild(unknownBtn);
    rateWrap.appendChild(knewBtn);

    revealBtn.addEventListener("click", () => {
      if (reverse) {
        translEl.textContent = entry.word;
        if (entry.phonetic) {
          const phonEl = document.createElement("div");
          phonEl.className = "flashcard-phonetic";
          phonEl.textContent = formatPhonetic(entry.phonetic);
          translEl.after(phonEl);
        }
        speakBtns.style.display = "";
        if (clozeEl) {
          // Resolve a lacuna mostrando a frase completa
          clozeEl.textContent = entry.context;
        } else if (entry.context) {
          const ctx = document.createElement("div");
          ctx.className = "flashcard-context";
          ctx.textContent = entry.context;
          card.appendChild(ctx);
        }
      } else {
        translEl.textContent = entry.translation;
        if (entry.context) {
          const ctx = document.createElement("div");
          ctx.className = "flashcard-context";
          ctx.textContent = entry.context;
          card.appendChild(ctx);
        }
      }
      revealBtn.style.display = "none";
      rateWrap.style.display = "flex";
    });

    revealWrap.appendChild(rateWrap);

    practiceContent.appendChild(hdr);
    practiceContent.appendChild(card);
    practiceContent.appendChild(revealWrap);
  }

  function showComplete() {
    practiceContent.innerHTML = "";
    const done = document.createElement("div");
    done.className = "session-complete";
    done.innerHTML = `
      <div class="session-complete-icon">🎉</div>
      <div class="session-complete-title">${s("practiceComplete") || "Sessão concluída!"}</div>
      <div class="session-complete-sub">${queue.length} ${s("statWords") || "palavras"}</div>
      <div class="session-complete-stats">
        <div class="complete-stat">
          <div class="complete-stat-num green">${correct}</div>
          <div class="complete-stat-label">${s("knew") || "Sabia"}</div>
        </div>
        <div class="complete-stat">
          <div class="complete-stat-num red">${wrong}</div>
          <div class="complete-stat-label">${s("didntKnow") || "Não sabia"}</div>
        </div>
      </div>
    `;

    const backBtn = document.createElement("button");
    backBtn.className = "btn-secondary";
    backBtn.textContent = "← " + (s("tabList") || "Lista");
    backBtn.addEventListener("click", () => {
      switchTab("list");
    });

    done.appendChild(backBtn);

    // Momento de valor: convite de apoio após concluir a sessão
    if (donationConfigured) {
      const sup = document.createElement("button");
      sup.type = "button";
      sup.className = "support-link session-support";
      const heart = document.createElement("span");
      heart.className = "support-link-heart";
      heart.setAttribute("aria-hidden", "true");
      heart.textContent = "❤";
      sup.appendChild(heart);
      sup.appendChild(document.createTextNode(" " + (s("supportTitle") || "Apoie o projeto")));
      sup.addEventListener("click", openSupportModal);
      done.appendChild(sup);
    }

    practiceContent.appendChild(done);
  }

  showCard();
}
