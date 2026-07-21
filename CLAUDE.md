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
- `result.html` — pinned preview: Copy / Save / OCR / Copy text / Pin. Text layer =
  absolutely positioned transparent spans per OCR word, `scaleX`-stretched to the
  word's bbox so native browser selection lines up with pixels.

## Testing (no manual UI needed)

- `bun run selftest -- <image.png>` — full result-window + OCR pipeline on a known
  image; prints `SELFTEST_WORDS=` and the recognized text, exits non-zero on failure.
- `bunx electron . --test-capture` — real capture path; flashes the overlay ~1 s,
  prints captured display sizes, exits.

## Conventions

- Version bumps: `package.json` + git tag `vX.Y.Z`, GitHub release on `qqubica/scr-ocr`.
- Keep the app dependency-light; no frameworks in renderers.
