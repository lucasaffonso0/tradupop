# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Loading the Extension

No build step — load directly in Chrome:
1. Open `chrome://extensions/`
2. Enable **Developer mode**
3. Click **Load unpacked** → select this folder
4. After any code change, click the reload (↺) button on the extension card

## Architecture

This is a **Manifest V3** Chrome extension with no bundler or dependencies.

### Data flow for translation

1. User selects text on a page → `content.js` catches `mouseup`
2. `content.js` sends `{type: "TRANSLATE_TEXT"}` to `background.js` via `chrome.runtime.sendMessage`
3. `background.js` calls Google Translate API (primary) → MyMemory API (fallback), caches result in-memory (`translationCache` Map, TTL 1h, max 500 items)
4. Response returns to `content.js` → `showPopup()` renders the floating popup in the page DOM

### Key files

| File | Role |
|---|---|
| `background.js` | Service worker — all network requests (translation, phonetic fallback), in-memory cache, context menu |
| `content.js` | Injected into every page — selection handling, popup DOM creation/positioning, TTS, save-word logic |
| `styles.css` | All styles for the in-page translation popup (scoped under `.translate-selection-popup`) |
| `ui-strings.js` | i18n strings for 5 languages (pt/en/es/fr/de) — loaded as a content script before `content.js` |
| `vocabulary.html/js/css` | Standalone full-page Anki-like vocabulary manager (opens in a new tab) |
| `popup.html/js/css` | Extension popup panel — settings only (dark mode, languages, shortcut, link to vocabulary) |

### Storage schema (`chrome.storage.local`)

| Key | Type | Description |
|---|---|---|
| `savedWords` | `Array<{word, translation, savedAt, context?, reviewLevel?, nextReview?}>` | Vocabulary list with spaced repetition metadata |
| `pinnedPosition` | `{top: string, left: string}` | Viewport-relative coords when popup is pinned (persists across tabs/windows) |
| `sourceLang` / `targetLang` | string | BCP-47 language codes (default `en` / `pt`) |
| `uiLang` | string | Interface language for i18n (default `pt`) |
| `darkMode` | boolean | |
| `shortcutKey` | string | Single char for `Ctrl+<key>` TTS shortcut (default `q`) |

### Sentinels in `content.js`

Two private sentinel strings prevent string comparisons on user-visible text:
- `LOADING_SENTINEL = "\x00loading\x00"` — popup is showing a loading state
- `ERROR_SENTINEL = "\x00error\x00"` — popup is showing an error card

`showPopup()` branches on these values to decide which UI to render.

### Popup positioning

The in-page popup uses `position: absolute` normally. When pinned (📌), it switches to `position: fixed` (CSS class `is-pinned`) so it stays in the viewport during scroll. Pinned position is saved to storage and shared across all tabs.

### TTS strategy

- **Normal speed**: Google TTS URL (`translate.googleapis.com/translate_tts`) → Web Speech API fallback
- **Slow speed**: Web Speech API directly at `rate = 0.55` (Google TTS has no speed parameter)

### Phonetic transcription

`background.js` extracts phonetics from Google Translate response (`data[0][N][3]`). If empty, falls back to `api.dictionaryapi.dev` (English words only).

### Spaced repetition

Vocabulary uses a simplified SM-2 algorithm. Each saved word has `reviewLevel` (0–5) and `nextReview` (timestamp). `REVIEW_INTERVALS = [0, 1, 3, 7, 14, 30]` days. Managed entirely in `vocabulary.js`.

## External APIs (all unauthenticated)

| API | Purpose |
|---|---|
| `translate.googleapis.com/translate_a/single` | Translation + phonetics + dictionary + examples |
| `translate.googleapis.com/translate_tts` | Text-to-speech audio |
| `api.mymemory.translated.net` | Translation fallback |
| `api.dictionaryapi.dev` | Phonetic IPA fallback (English only) |
