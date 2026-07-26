# CLAUDE.md — SCR-OCR

Windows area-screenshot tool with a selectable OCR text layer over the image.
Public repo: `qqubica/scr-ocr` (MIT). Nested git repo inside the Claude workspace
(gitignored by the parent, like true-dark).

## Stack & architecture

- Electron (no bundler, no build step; plain HTML/JS renderers with
  `nodeIntegration: true`). Package manager: **Bun** (`trustedDependencies: electron`).
- `main.js` — tray, global hotkey (`HOTKEY`), capture via `desktopCapturer`
  (per-display, native resolution), crop with `nativeImage.crop` (CSS px × scaleFactor),
  clipboard/save IPC, **OCR runs here** via tesseract.js (`OCR_LANGS`, default
  `eng+pol`) — renderers can't spawn Node worker_threads, so OCR is a `run-ocr`
  IPC handler; traineddata cached in `userData/tessdata`.
- `overlay.html` — fullscreen frozen-frame region selector (one window per display).
- `result.html` — pinned preview: New (screenshot) / Copy / Save / OCR / Copy text /
  Pin. **New discards all open previews** (hidden, then destroyed — hide first,
  or the OS close animation's fading ghost lands in the capture) — the old shot
  is either saved by then or thrown away. Launcher + previews are
  **content-protected** (`setContentProtection`, WDA_EXCLUDEFROMCAPTURE): they
  stay on screen but never appear in captured frames, so capture starts with
  zero delay (no hide-and-wait). Trade-off: the app's windows are also invisible
  to screen sharing and other capture tools. Skipped in selftest (capturePage
  shots). **Every capture is auto-copied to the clipboard** on selection
  (`overlay-selected` in `main.js`; the result window flashes "Copied to clipboard") —
  the Copy button stays for re-copying later. Selftest bypasses this (flag passed
  through `openResult` → `result-init`), so test runs don't touch the clipboard. Text layer =
  absolutely positioned transparent spans per OCR word, `scaleX`-stretched to the
  word's bbox so native browser selection lines up with pixels. Highlights are
  quiet glass bars in a separate **untransformed** layer (`#hlLayer` — borders/radii
  on the stretched spans would distort): neighboring words in a line merge into one
  padded run, sized to the line's **font box** (`lineY0/lineY1` from `run-ocr`:
  baseline + Tesseract row metrics `row_height`/`descenders`, ink bbox as
  fallback when the fit looks implausible; lines with near-identical row heights
  then snap to their group's median), so bars are pixel-identical across lines
  of the same text size no matter which glyphs occur (x-height only, caps,
  descenders). After the height is settled each bar is **recentered on its
  line's ink bbox** — baseline+descender anchoring left descender-less lines
  ("23°C", digits, ALL CAPS) top-flush with all the slack hanging below, and
  glyphs above the fitted ascender (², °, quote marks) could poke out of the
  bar; for full-ink lines recentering is a no-op, so mixed-text paragraphs
  keep their baseline rhythm. Copying a selection is handled by a `copy` listener that rebuilds
  the text from the OCR words (`renderedWords`, reading order) — the spans are
  out of flow so the browser would otherwise serialize the range as bare words
  with no whitespace. It inserts a space between words on the same line (vertical
  `lineY0/lineY1` overlap), a `\n` between lines, and `\n\n` when the vertical gap
  exceeds ~0.6 line height (paragraph break). "Copy text" (whole doc) still uses
  Tesseract's `data.text`.

## Dev loop

- `bun run dev` — runs the app under **electronmon**: a `main.js` change fully
  restarts the app, an HTML/CSS change hot-reloads the windows (no build step
  exists, so this is the whole loop). Depends on the `before-quit` handler in
  `main.js` setting `app.isQuitting` — without it the launcher's
  minimize-to-tray close handler blocks electronmon's restart (and OS shutdown).

## Packaging / local install

- `bun run dist` — `@electron/packager` builds a portable win32-x64 app into
  `dist/SCR-OCR-win32-x64` (asar; OCR from asar verified via selftest on the
  packaged exe). Exe icon: `assets/icon.ico`, generated from the 64px
  `assets/icon.png` (multi-size, PNG-entry ico).
- Local install = copy that folder to `%LOCALAPPDATA%\Programs\SCR-OCR` +
  Start Menu shortcut (no installer, by design). Installed 2026-07-23.
  Packaged app keeps its own `userData` (`SCR-OCR`), so traineddata re-downloads
  once on first OCR.

## Testing (no manual UI needed)

- `bun run selftest -- <image.png>` — full result-window + OCR pipeline on a known
  image; prints `SELFTEST_WORDS=` and the recognized text, exits non-zero on failure.
  `SELFTEST_SHOT=<path.png>` additionally saves a screenshot of the result window
  with the text layer visible (visual check of the overlay).
- `bunx electron . --test-capture` — real capture path; flashes the overlay ~1 s,
  prints captured display sizes, exits.

## Design

- UI uses the **Speed · Soft Round** theme: `theme-soft-round.css` is a **verbatim
  copy of `../speed-theme/theme-soft-round.css`** (design source of truth) — to
  update the look, edit it there and re-copy; never fork the copy. Renderers opt
  in via `.sp-*` classes plus small app-level CSS (toolbar density, close button,
  active states) in each HTML file.
- Launcher + result follow the OS light/dark mode; `main.js` mirrors the theme
  grounds in each window's `backgroundColor` (`themeBg()`) so nothing flashes
  before first paint. The overlay is pinned dark (`<html data-theme="dark">`) —
  it always sits over a dimmed frozen frame — and uses the theme's glass tokens
  for the hint and size readout.
- The screenshot itself stays square-cornered and pixel-true: the frame gets
  outline + shadow only (a border would offset the text layer's coordinates).

## Conventions

- Version bumps: `package.json` + git tag `vX.Y.Z`, GitHub release on `qqubica/scr-ocr`.
- Keep the app dependency-light; no frameworks in renderers.
