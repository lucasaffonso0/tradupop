// ── Internacionalização ──
let uiLang = "pt";
function s(key) { return (UI_STRINGS[uiLang] || UI_STRINGS["pt"])[key] || key; }

// ── Estado ──
let allWords = [];
let undoTimer = null;
let toastHideTimer = null;
let pendingDelete = null;
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
  const level = knew ? Math.min((word.reviewLevel || 0) + 1, 5) : 0;
  return { ...word, reviewLevel: level, nextReview: Date.now() + REVIEW_INTERVALS[level] };
}

// LANG_TTS é global definido em ui-strings.js
let sourceLang = "en";

function speakWord(word, slow = false) {
  const ttsLang = LANG_TTS[sourceLang] || "en-US";
  if (slow) {
    if (!("speechSynthesis" in window)) return;
    window.speechSynthesis.cancel();
    const utt = new SpeechSynthesisUtterance(word);
    utt.lang = ttsLang;
    utt.rate = 0.55;
    window.speechSynthesis.speak(utt);
    return;
  }
  const ttsUrl = `https://translate.googleapis.com/translate_tts?ie=UTF-8&tl=${ttsLang}&client=gtx&q=${encodeURIComponent(word)}`;
  const audio = new Audio(ttsUrl);
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
chrome.storage.local.get(["savedWords", "darkMode", "uiLang", "sourceLang"], (result) => {
  uiLang = result.uiLang || "pt";
  sourceLang = result.sourceLang || "en";
  applyStrings();

  if (result.darkMode) {
    darkToggle.checked = true;
    document.body.classList.add("dark");
  }

  allWords = Array.isArray(result.savedWords) ? result.savedWords : [];
  renderList();
  updateStats();
});

// Sincroniza mudanças feitas em outra aba/popup
chrome.storage.onChanged.addListener((changes) => {
  if (changes.savedWords) {
    // Ignora echo de escritas locais para não destruir estado de undo em progresso
    if (!localWrite) {
      allWords = Array.isArray(changes.savedWords.newValue) ? changes.savedWords.newValue : [];
      renderList();
      updateStats();
    }
  }
  if (changes.darkMode) {
    darkToggle.checked = !!changes.darkMode.newValue;
    document.body.classList.toggle("dark", !!changes.darkMode.newValue);
  }
  if (changes.uiLang) {
    uiLang = changes.uiLang.newValue || "pt";
    applyStrings();
  }
  if (changes.sourceLang) {
    sourceLang = changes.sourceLang.newValue || "en";
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
  };
  for (const [id, text] of Object.entries(map)) {
    const el = document.getElementById(id);
    if (el) el.textContent = text;
  }
  wordSearch.placeholder = s("searchPlaceholder") || "Buscar palavra...";
  undoBtn.textContent = s("undo") || "Desfazer";
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
function renderList(filter) {
  wordList.innerHTML = "";
  const words = filter
    ? allWords.filter(w =>
        w.word.toLowerCase().includes(filter) ||
        w.translation.toLowerCase().includes(filter))
    : allWords;

  const sorted = [...words].sort((a, b) => a.word.localeCompare(b.word));

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

    // Speak btn (normal)
    const speakBtn = document.createElement("button");
    speakBtn.className = "word-action-btn";
    speakBtn.title = s("listenIn") + " English";
    speakBtn.innerHTML = `<svg viewBox="0 0 24 24"><path d="M11 5L6 9H2v6h4l5 4V5z"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"/></svg>`;
    speakBtn.addEventListener("click", (e) => { e.stopPropagation(); speakWord(entry.word); });

    // Speak btn (slow)
    const speakSlowBtn = document.createElement("button");
    speakSlowBtn.className = "word-action-btn slow";
    speakSlowBtn.title = s("listenSlow") || "Ouvir devagar";
    speakSlowBtn.innerHTML = `<svg viewBox="0 0 24 24"><path d="M11 5L6 9H2v6h4l5 4V5z"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/></svg>`;
    speakSlowBtn.addEventListener("click", (e) => { e.stopPropagation(); speakWord(entry.word, true); });

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

// ── Delete com Undo ──
function deleteWord(word) {
  const q = wordSearch.value.trim().toLowerCase() || undefined;
  clearTimeout(undoTimer);
  clearTimeout(toastHideTimer);

  const original = [...allWords];
  allWords = allWords.filter(w => w.word.toLowerCase() !== word.toLowerCase());
  renderList(q);
  updateStats();

  undoMsg.textContent = `"${word}" ${s("wordRemoved") || "removida."}`;
  undoToast.style.display = "flex";

  // Sobrescreve handler anterior de forma segura
  undoBtn.onclick = () => {
    clearTimeout(undoTimer);
    clearTimeout(toastHideTimer);
    undoTimer = null;
    allWords = original;
    pendingDelete = null;
    renderList(q);
    updateStats();
    undoToast.style.display = "none";
  };

  toastHideTimer = setTimeout(() => {
    undoToast.style.display = "none";
  }, 5000);

  undoTimer = setTimeout(() => {
    localWrite = true;
    chrome.storage.local.set({ savedWords: allWords }, () => { localWrite = false; });
    pendingDelete = null;
  }, 5000);

  pendingDelete = original;
}

function showUndoToast() { /* lógica movida para deleteWord */ }

// ── Clear all ──
clearAllBtn.addEventListener("click", () => {
  if (!confirm(s("confirmClearAll"))) return;
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
      renderList();
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
    empty.innerHTML = `
      <div class="practice-empty-icon">📚</div>
      <div class="practice-empty-title">${s("noWords") || "Nenhuma palavra salva."}</div>
      <div class="practice-empty-sub">${s("noWordsHint") || "Salve pelo menos 3 palavras para praticar."}</div>
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
    modeReview.addEventListener("click", () => startSession([...due].sort(() => Math.random() - 0.5)));
    modes.appendChild(modeReview);
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
  modeAll.addEventListener("click", () => startSession([...allWords].sort(() => Math.random() - 0.5)));
  modes.appendChild(modeAll);

  start.appendChild(title);
  start.appendChild(sub);
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
  let sessionWords = [...allWords];

  function showCard() {
    practiceContent.innerHTML = "";

    if (idx >= queue.length) {
      saveSessionProgress(sessionWords);
      showComplete();
      return;
    }

    const entry = queue[idx];
    const pct = Math.round((idx / queue.length) * 100);

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

    // Lang tag
    const langTag = document.createElement("span");
    langTag.className = "flashcard-lang";
    langTag.textContent = "English";
    card.appendChild(langTag);

    // Speak buttons
    const speakBtns = document.createElement("div");
    speakBtns.className = "flashcard-speak-group";

    const speakBtn = document.createElement("button");
    speakBtn.className = "flashcard-speak";
    speakBtn.title = s("listenIn") || "Ouvir";
    speakBtn.innerHTML = `<svg viewBox="0 0 24 24"><path d="M11 5L6 9H2v6h4l5 4V5z"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"/></svg>`;
    speakBtn.addEventListener("click", () => speakWord(entry.word));

    const speakSlowBtn = document.createElement("button");
    speakSlowBtn.className = "flashcard-speak slow";
    speakSlowBtn.title = s("listenSlow") || "Ouvir devagar";
    speakSlowBtn.innerHTML = `<svg viewBox="0 0 24 24"><path d="M11 5L6 9H2v6h4l5 4V5z"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/></svg>`;
    speakSlowBtn.addEventListener("click", () => speakWord(entry.word, true));

    speakBtns.appendChild(speakBtn);
    speakBtns.appendChild(speakSlowBtn);
    card.appendChild(speakBtns);

    const wordEl = document.createElement("div");
    wordEl.className = "flashcard-word";
    wordEl.textContent = entry.word;
    card.appendChild(wordEl);

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
      translEl.textContent = entry.translation;
      if (entry.context) {
        const ctx = document.createElement("div");
        ctx.className = "flashcard-context";
        ctx.textContent = entry.context;
        card.appendChild(ctx);
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
    practiceContent.appendChild(done);
  }

  showCard();
}
