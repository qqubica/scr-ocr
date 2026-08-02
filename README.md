# SCR-OCR

Area screenshot tool for Windows with a live-text OCR overlay. Select a region of the
screen, get a pinned preview with the usual screenshot actions — and one more: **OCR**,
which recognizes the text in the image and lays it *over* the screenshot as real,
selectable text. Drag across the image to select words exactly where they appear and
copy them like normal text (think macOS Live Text, but for any screenshot).

## Features

- **Area selection** — global hotkey `PrtSc` (or the tray icon / launcher button)
  freezes the screen; drag to pick a region, `Esc` cancels. Multi-monitor and
  HiDPI-aware (captures at native resolution).
- **Delayed capture** — take the shot after 1, 2, 3, 5 or 10 seconds (launcher
  buttons or the tray's *Take screenshot after delay* submenu), with a live
  countdown in the launcher and tray tooltip. Handy for menus, tooltips and other
  UI that closes when you press a key. Cancel from the launcher; pressing `PrtSc`
  during the countdown captures immediately instead.
- **Screenshot actions** — the captured region opens in a small always-on-top window
  with a normal Windows frame (resizable, snap layouts, and native minimize /
  maximize / close buttons sitting in the toolbar row):
  - **New** — take another screenshot
  - **Copy** — image to clipboard (`Ctrl+C`)
  - **Save** — PNG via save dialog (`Ctrl+S`)
  - **Pin** — toggle always-on-top
  - **OCR** — recognize text (English + Polish by default)
- **Live-text overlay** — after OCR, every recognized word is positioned over its
  location in the image as transparent selectable text. Select with the mouse,
  `Ctrl+A` to select all, `Ctrl+C` copies the selection; **Copy text** grabs the
  whole recognized text at once. The OCR button then toggles the layer on/off.
- **Offline after first run** — Tesseract traineddata is downloaded once and cached
  in the app's user-data folder.
- **Follows your system theme** — light and dark mode, switching live with the OS.

## Run

Requires [Bun](https://bun.sh) (or npm) and an internet connection for the first
`install` and the first OCR (language data download).

```sh
bun install
bun start
```

The app lives in the system tray; closing the launcher window keeps it running.
Trigger a capture with `PrtSc`, the tray menu, or by double-clicking the tray icon.

## Configuration

- **OCR languages** — edit `OCR_LANGS` at the top of `main.js`
  (Tesseract codes, `+`-separated, e.g. `eng+deu`).
- **Hotkey** — edit `HOTKEY` in `main.js`
  ([Electron accelerator syntax](https://www.electronjs.org/docs/latest/api/accelerator)).

## How it works

Electron app, no build step. `desktopCapturer` grabs each display at native
resolution; a fullscreen frameless window shows the frozen frame for region
selection; the crop opens in a result window. OCR runs
[tesseract.js](https://github.com/naptha/tesseract.js) in the main process
(renderers can't spawn Node worker threads) and returns per-word bounding boxes
plus each text line's vertical extent; the renderer stretches each word of
transparent text over its box (`transform: scaleX`) so the browser's own text
selection lines up with the pixels, and marks recognized text with quiet glass
highlight bars — neighboring words merge into one padded run per line, with a
uniform height regardless of glyph shapes.

## Development

End-to-end OCR selftest (renders a result window from a known image, OCRs it,
prints the text, exits):

```sh
bun run selftest -- path/to/image.png
```

Set `SELFTEST_SHOT=path/to/shot.png` to also save a screenshot of the result
window with the text layer visible.

Test runs (`--selftest`, `--test-capture`) stay out of the way of an installed
SCR-OCR you already have running: they never request the single-instance lock —
which would make that instance pop a capture overlay — and they keep their own
user-data folder (`%TEMP%\scr-ocr-test-userdata`) instead of sharing its cache.

`bunx electron . --test-capture` briefly exercises the real capture + overlay path
and prints what was captured.

## License

MIT
