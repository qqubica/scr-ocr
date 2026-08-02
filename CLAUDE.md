# CLAUDE.md — SCR-OCR

Windows area-screenshot tool with a selectable OCR text layer over the image.
Public repo: `qqubica/scr-ocr` (MIT). Nested git repo inside the Claude workspace
(gitignored by the parent, like true-dark).

Architecture is summarized in README "How it works"; the non-obvious decisions
(content protection, highlight-bar metrics, copy rebuild) are documented as
comments at the code sites in main.js / result.html — preserve those comments
when editing.

## Packaging / local install

- `bun run dist` — `@electron/packager` builds a portable win32-x64 app into
  `dist/SCR-OCR-win32-x64` (asar; OCR from asar verified via selftest on the
  packaged exe). Exe icon: `assets/icon.ico`, generated from the 64px
  `assets/icon.png` (multi-size, PNG-entry ico).
- Local install = copy that folder to `%LOCALAPPDATA%\Programs\SCR-OCR` +
  Start Menu shortcut (no installer, by design). Installed 2026-07-23.
  Packaged app keeps its own `userData` (`SCR-OCR`), so traineddata re-downloads
  once on first OCR.

## Design

- UI uses the **Speed · Soft Round** theme: `theme-soft-round.css` is a **verbatim
  copy of `../speed-theme/theme-soft-round.css`** (design source of truth) — to
  update the look, edit it there and re-copy; never fork the copy. Renderers opt
  in via `.sp-*` classes plus small app-level CSS (toolbar density, active
  states) in each HTML file.
- The result window uses the OS frame with `titleBarStyle: 'hidden'` +
  `titleBarOverlay` (Windows Controls Overlay): its 52px toolbar **is** the title
  bar and Windows paints the caption buttons into its right end, themed with
  `--sp-surface`/`--sp-text` (repainted on `nativeTheme` 'updated'). Keep
  `RESULT_TOOLBAR` in main.js equal to `#toolbar`'s height, and don't add a
  custom close button back — the native one covers it (Esc still closes).

## Conventions

- Version bumps: `package.json` + git tag `vX.Y.Z`, GitHub release on `qqubica/scr-ocr`.
- Keep the app dependency-light; no frameworks in renderers.
