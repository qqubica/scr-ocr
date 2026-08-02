const {
  app,
  BrowserWindow,
  Tray,
  Menu,
  globalShortcut,
  ipcMain,
  desktopCapturer,
  screen,
  nativeImage,
  clipboard,
  dialog,
  shell,
  nativeTheme,
} = require('electron');
const path = require('path');
const fs = require('fs');

const HOTKEY = 'PrintScreen';
const HOTKEY_LABEL = 'PrtSc';
// Speed · Soft Round theme grounds (theme-soft-round.css --sp-bg), used as the
// window backgroundColor so nothing flashes before the renderer paints.
const themeBg = () => (nativeTheme.shouldUseDarkColors ? '#191a1d' : '#faf9f7');
// Native caption buttons (minimize / maximize / close) are drawn by Windows as a
// Window Controls Overlay on top of the result window's toolbar row; these are
// the theme's surface + text colors (--sp-surface / --sp-text) so the OS buttons
// sit flush in it. RESULT_TOOLBAR must match #toolbar's height in result.html.
const RESULT_TOOLBAR = 52;
const titleBarOverlay = () => ({
  color: nativeTheme.shouldUseDarkColors ? '#232428' : '#ffffff',
  symbolColor: nativeTheme.shouldUseDarkColors ? '#e8e6e1' : '#302e29',
  height: RESULT_TOOLBAR,
});
// Tesseract language(s), '+'-separated. Traineddata is downloaded on first OCR
// and cached in the app's user-data folder, so later runs work offline.
const OCR_LANGS = 'eng+pol';

let tray = null;
let launcherWin = null;
let overlayWins = [];
// displayId -> { image: NativeImage, scaleFactor, bounds }
let captures = new Map();
let capturing = false;
// seconds-granularity countdown to a delayed capture; only one can be pending
let delayInterval = null;
// delay presets offered in the tray submenu and the launcher
const DELAYS = [1, 2, 3, 5, 10];

const selftestArg = process.argv.indexOf('--selftest');
const SELFTEST = selftestArg !== -1;
const SELFTEST_IMAGE = SELFTEST ? process.argv[selftestArg + 1] : null;
const TEST_CAPTURE = process.argv.includes('--test-capture');
// Test runs get their own user-data folder: sharing it with an installed SCR-OCR
// means two Electron apps fighting over the same disk cache ("Unable to move the
// cache") and lets a test write into the user's real app data.
if (SELFTEST || TEST_CAPTURE)
  app.setPath('userData', path.join(app.getPath('temp'), 'scr-ocr-test-userdata'));
// software compositing makes SELFTEST_SHOT captures deterministic — with GPU
// compositing, capturePage can return a stale frame (esp. in sandboxed runs)
if (SELFTEST) app.disableHardwareAcceleration();

// ---------------------------------------------------------------- launcher

function createLauncher() {
  launcherWin = new BrowserWindow({
    width: 380,
    height: 290,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    show: !SELFTEST && !TEST_CAPTURE,
    backgroundColor: themeBg(),
    icon: path.join(__dirname, 'assets', 'icon.png'),
    webPreferences: { nodeIntegration: true, contextIsolation: false },
  });
  launcherWin.removeMenu();
  // WDA_EXCLUDEFROMCAPTURE: the window stays visible to the user but never
  // appears in captured frames — so startCapture doesn't have to hide app
  // windows and wait for the compositor. Side effect: invisible to screen
  // sharing / other capture tools too.
  launcherWin.setContentProtection(true);
  launcherWin.loadFile('launcher.html');
  launcherWin.on('close', (e) => {
    // minimize to tray instead of quitting
    if (!app.isQuitting) {
      e.preventDefault();
      launcherWin.hide();
    }
  });
}

function createTray() {
  const iconPath = path.join(__dirname, 'assets', 'icon.png');
  let icon = nativeImage.createFromPath(iconPath);
  if (icon.isEmpty()) icon = nativeImage.createEmpty();
  tray = new Tray(icon.resize({ width: 16, height: 16 }));
  tray.setToolTip(trayTooltip());
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: `Take screenshot\t${HOTKEY_LABEL}`, click: () => startCapture() },
      {
        label: 'Take screenshot after delay',
        submenu: DELAYS.map((s) => ({
          label: `${s} second${s === 1 ? '' : 's'}`,
          click: () => startCaptureDelayed(s),
        })),
      },
      { label: 'Show window', click: () => launcherWin.show() },
      { type: 'separator' },
      {
        label: 'Quit',
        click: () => {
          app.isQuitting = true;
          app.quit();
        },
      },
    ])
  );
  tray.on('double-click', () => startCapture());
}

// ---------------------------------------------------------------- capture

const trayTooltip = () => `SCR-OCR — area screenshot + OCR (${HOTKEY_LABEL})`;

// notify the launcher so it can show/clear its countdown (0 = no delay pending)
function sendDelayTick(remaining) {
  if (launcherWin && !launcherWin.isDestroyed())
    launcherWin.webContents.send('delay-tick', remaining);
  if (tray)
    tray.setToolTip(remaining > 0 ? `SCR-OCR — capturing in ${remaining}s…` : trayTooltip());
}

function cancelDelayedCapture() {
  if (!delayInterval) return;
  clearInterval(delayInterval);
  delayInterval = null;
  sendDelayTick(0);
}

// waits `seconds`, then captures. The app's own windows are content-protected
// (never appear in the frame), so nothing needs hiding during the countdown —
// the delay exists purely to let the user arrange the screen (open a menu,
// hover a tooltip) before the frame is frozen.
function startCaptureDelayed(seconds) {
  cancelDelayedCapture();
  if (capturing || overlayWins.length) return;
  let remaining = Math.round(seconds);
  if (!(remaining > 0)) return startCapture();
  sendDelayTick(remaining);
  delayInterval = setInterval(() => {
    remaining -= 1;
    if (remaining <= 0) {
      cancelDelayedCapture();
      startCapture();
    } else {
      sendDelayTick(remaining);
    }
  }, 1000);
}

async function startCapture({ discard = false } = {}) {
  // an immediate capture request (hotkey, button) wins over a pending countdown
  cancelDelayedCapture();
  if (capturing || overlayWins.length) return;
  capturing = true;
  try {
    // "New" discards every open preview — the old screenshot is either saved
    // by then or explicitly thrown away. hide() before destroy(): destroying
    // a visible window plays the OS close animation.
    if (discard) {
      for (const w of BrowserWindow.getAllWindows()) {
        if (w !== launcherWin && !w.isDestroyed()) {
          if (w.isVisible()) w.hide();
          w.destroy();
        }
      }
    }
    // every app window is content-protected (WDA_EXCLUDEFROMCAPTURE, see
    // createLauncher/openResult), so none of our own UI can appear in the
    // frame — grab it immediately, no hiding or compositor wait needed

    const displays = screen.getAllDisplays();
    const maxW = Math.max(...displays.map((d) => d.size.width * d.scaleFactor));
    const maxH = Math.max(...displays.map((d) => d.size.height * d.scaleFactor));
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: maxW, height: maxH },
    });

    captures.clear();
    for (const display of displays) {
      const source =
        sources.find((s) => String(s.display_id) === String(display.id)) ||
        (displays.length === 1 ? sources[0] : null);
      if (!source) continue;
      captures.set(display.id, {
        image: source.thumbnail,
        scaleFactor: display.scaleFactor,
        bounds: display.bounds,
      });
    }

    for (const display of displays) {
      if (!captures.has(display.id)) continue;
      const win = new BrowserWindow({
        x: display.bounds.x,
        y: display.bounds.y,
        width: display.bounds.width,
        height: display.bounds.height,
        frame: false,
        transparent: false,
        resizable: false,
        movable: false,
        skipTaskbar: true,
        alwaysOnTop: true,
        show: false,
        backgroundColor: '#000000',
        webPreferences: { nodeIntegration: true, contextIsolation: false },
      });
      win.setAlwaysOnTop(true, 'screen-saver');
      win.loadFile('overlay.html', { query: { displayId: String(display.id) } });
      win.once('ready-to-show', () => {
        win.setBounds(display.bounds);
        win.setFullScreen(true);
        win.show();
        win.focus();
      });
      overlayWins.push(win);
    }

    if (TEST_CAPTURE) {
      // report what was captured, then tear down and exit
      setTimeout(() => {
        for (const [id, cap] of captures) {
          const s = cap.image.getSize();
          console.log(
            `TEST_CAPTURE display=${id} image=${s.width}x${s.height} scale=${cap.scaleFactor} bounds=${JSON.stringify(cap.bounds)}`
          );
        }
        console.log(`TEST_CAPTURE overlays=${overlayWins.length}`);
        closeOverlays();
        app.isQuitting = true;
        app.exit(0);
      }, 1200);
    }
  } finally {
    capturing = false;
  }
}

function closeOverlays() {
  for (const w of overlayWins) {
    if (!w.isDestroyed()) w.destroy();
  }
  overlayWins = [];
}

ipcMain.handle('overlay-get-image', (e, displayId) => {
  const cap = captures.get(Number(displayId)) || captures.get(displayId);
  if (!cap) return null;
  return { dataUrl: cap.image.toDataURL(), scaleFactor: cap.scaleFactor };
});

ipcMain.on('overlay-cancel', () => closeOverlays());

// sent by the launcher's big button and the result window's "New" button.
// "New" ({discard: true}) throws away every open preview — the old screenshot
// is either saved by then or explicitly discarded in favor of the next one.
ipcMain.on('start-capture', (e, opts) => startCapture(opts));

// launcher delay buttons; a second request just restarts the countdown
ipcMain.on('start-capture-delayed', (e, seconds) => startCaptureDelayed(Number(seconds)));
ipcMain.on('cancel-delayed-capture', () => cancelDelayedCapture());

ipcMain.on('overlay-selected', (e, { displayId, rect }) => {
  const cap = captures.get(Number(displayId)) || captures.get(displayId);
  closeOverlays();
  if (!cap) return;
  const sf = cap.scaleFactor;
  const imgSize = cap.image.getSize(); // physical pixels
  const crop = {
    x: Math.max(0, Math.round(rect.x * sf)),
    y: Math.max(0, Math.round(rect.y * sf)),
    width: Math.round(rect.w * sf),
    height: Math.round(rect.h * sf),
  };
  crop.width = Math.min(crop.width, imgSize.width - crop.x);
  crop.height = Math.min(crop.height, imgSize.height - crop.y);
  if (crop.width < 3 || crop.height < 3) return;
  const cropped = cap.image.crop(crop);
  // the shot lands on the clipboard immediately — Copy in the result window
  // stays for re-copying after the clipboard is overwritten
  clipboard.writeImage(cropped);
  openResult(
    cropped,
    sf,
    {
      x: cap.bounds.x + rect.x,
      y: cap.bounds.y + rect.y,
      w: rect.w,
      h: rect.h,
    },
    { copied: true }
  );
});

// ---------------------------------------------------------------- result

function openResult(image, scaleFactor, screenRect, { copied = false } = {}) {
  const png = image.toPNG();
  const size = image.getSize();
  const cssW = Math.round(size.width / scaleFactor);
  const cssH = Math.round(size.height / scaleFactor);

  const TOOLBAR = RESULT_TOOLBAR;
  // width floor for narrow captures: all toolbar buttons (~545px in their widest
  // state, "OCR ✓" + "📌 Pinned"), the native caption buttons overlaid on the
  // right of the toolbar (~140px), plus enough #status room that short feedback
  // ("Image copied", "Saved") stays readable; longer statuses ellipsize
  const MIN_W = 760;
  const winW = Math.max(cssW + 24, MIN_W);
  const winH = cssH + TOOLBAR + 24;

  const display = screen.getDisplayNearestPoint({
    x: Math.round(screenRect.x),
    y: Math.round(screenRect.y),
  });
  const wa = display.workArea;
  const finalW = Math.min(winW, wa.width);
  const finalH = Math.min(winH, wa.height);
  const x = Math.round(Math.min(Math.max(screenRect.x - 12, wa.x), wa.x + wa.width - finalW));
  const y = Math.round(Math.min(Math.max(screenRect.y - 12, wa.y), wa.y + wa.height - finalH));

  const win = new BrowserWindow({
    x,
    y,
    width: finalW,
    height: finalH,
    // Windows-style frame without a second title bar: `titleBarStyle: 'hidden'`
    // + titleBarOverlay keeps the OS frame (resize borders, rounded corners,
    // snap layouts on the maximize button, Alt+Space menu) and lets Windows
    // draw its native caption buttons over the top-right of our toolbar row —
    // the toolbar is the title bar, the way Explorer and Settings do it.
    titleBarStyle: 'hidden',
    titleBarOverlay: titleBarOverlay(),
    resizable: true,
    minWidth: Math.min(MIN_W, wa.width),
    minHeight: Math.min(TOOLBAR + 80, wa.height),
    skipTaskbar: false,
    alwaysOnTop: true,
    show: false,
    backgroundColor: themeBg(),
    icon: path.join(__dirname, 'assets', 'icon.png'),
    webPreferences: { nodeIntegration: true, contextIsolation: false },
  });
  win.removeMenu();
  // keep previews out of any screen capture (see createLauncher); skipped in
  // selftest so SELFTEST_SHOT's capturePage stays free of affinity flags
  if (!SELFTEST) win.setContentProtection(true);
  win.loadFile('result.html', { query: SELFTEST ? { selftest: '1' } : {} });
  win.webContents.once('did-finish-load', () => {
    win.webContents.send('result-init', {
      pngBase64: png.toString('base64'),
      cssW,
      cssH,
      physW: size.width,
      physH: size.height,
      copied,
    });
  });
  win.once('ready-to-show', () => win.show());
  // ready-to-show waits for a painted frame, which never arrives when nothing is
  // compositing (a headless/asleep machine running the selftest) — and a window
  // that is never shown stays hidden to the renderer, so img.decode() never
  // settles and OCR never starts. Show it anyway in tests.
  if (SELFTEST)
    setTimeout(() => {
      if (!win.isDestroyed() && !win.isVisible()) win.showInactive();
    }, 1500);
}

// the OS-drawn caption buttons don't know about our theme — repaint them when
// Windows flips light/dark (windows without an overlay just throw, skip those)
nativeTheme.on('updated', () => {
  for (const w of BrowserWindow.getAllWindows()) {
    if (w.isDestroyed()) continue;
    try {
      w.setTitleBarOverlay(titleBarOverlay());
    } catch {}
  }
});

ipcMain.on('result-copy-image', (e, pngBase64) => {
  clipboard.writeImage(nativeImage.createFromBuffer(Buffer.from(pngBase64, 'base64')));
});

ipcMain.on('result-copy-text', (e, text) => {
  clipboard.writeText(text);
});

ipcMain.handle('result-save', async (e, pngBase64) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  const ts = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const name = `screenshot-${ts.getFullYear()}${pad(ts.getMonth() + 1)}${pad(ts.getDate())}-${pad(
    ts.getHours()
  )}${pad(ts.getMinutes())}${pad(ts.getSeconds())}.png`;
  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    defaultPath: path.join(app.getPath('pictures'), name),
    filters: [{ name: 'PNG image', extensions: ['png'] }],
  });
  if (canceled || !filePath) return false;
  fs.writeFileSync(filePath, Buffer.from(pngBase64, 'base64'));
  return true;
});

ipcMain.on('result-pin', (e, pinned) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  if (win) win.setAlwaysOnTop(!!pinned, 'floating');
});

ipcMain.on('result-close', (e) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  if (win) win.close();
});

// OCR runs in the main process: tesseract.js needs Node worker_threads, which
// Electron only provides here, not in renderers.
ipcMain.handle('run-ocr', async (e, pngBase64) => {
  const sender = e.sender;
  const { createWorker } = require('tesseract.js');
  const worker = await createWorker(OCR_LANGS, 1, {
    cachePath: path.join(app.getPath('userData'), 'tessdata'),
    logger: (m) => {
      if (!sender.isDestroyed()) sender.send('ocr-progress', { status: m.status, progress: m.progress });
    },
  });
  try {
    const { data } = await worker.recognize(Buffer.from(pngBase64, 'base64'));
    // A line's raw bbox tracks the ink that happens to be in it — "some more news"
    // (x-height only) gets a shorter box than "Typography!" in the same font.
    // Tesseract's fitted row metrics (baseline + row_height/descenders, where
    // row_height spans ascender top to descender bottom) describe the font
    // instead, so highlight height stays uniform across lines of the same size.
    const lineExtent = (line) => {
      const bb = line.bbox;
      const ra = line.rowAttributes;
      const bl = line.baseline;
      if (bb && ra && ra.row_height > 0 && bl && bl.has_baseline) {
        const baseY = (bl.y0 + bl.y1) / 2;
        const desc = Math.max(0, ra.descenders);
        const y1 = baseY + desc;
        const y0 = y1 - ra.row_height;
        // trust the metrics only when they're sane against the actual ink —
        // row fitting can go wrong on sparse UI text
        const ink = bb.y1 - bb.y0;
        const overlap = Math.min(y1, bb.y1) - Math.max(y0, bb.y0);
        if (overlap >= ink * 0.5 && ra.row_height >= ink * 0.5 && ra.row_height <= ink * 3)
          return { y0, y1, baseY, rowH: ra.row_height, desc };
      }
      return bb ? { y0: bb.y0, y1: bb.y1 } : null;
    };
    // walk the layout hierarchy so each word carries its line's vertical extent —
    // the renderer sizes highlight boxes per line, not per glyph bbox
    const lines = [];
    for (const block of data.blocks || [])
      for (const par of block.paragraphs || [])
        for (const line of par.lines || []) {
          const ws = (line.words || []).filter((w) => w.text && w.text.trim() && w.bbox);
          if (ws.length) lines.push({ ext: lineExtent(line), bb: line.bbox, ws });
        }
    // metrics still wobble a little line-to-line (a line with no ascender or
    // descender ink gives the row fit nothing to work with), so snap lines of
    // near-identical size to their group's median — same-size text then gets
    // pixel-identical bars, while genuinely different sizes stay apart
    const fitted = lines.map((l) => l.ext).filter((x) => x && x.rowH);
    fitted.sort((a, b) => a.rowH - b.rowH);
    let group = [];
    const snapGroup = () => {
      if (group.length > 1) {
        const med = (arr) => arr.sort((a, b) => a - b)[Math.floor(arr.length / 2)];
        const h = med(group.map((x) => x.rowH));
        const d = med(group.map((x) => x.desc));
        for (const x of group) { x.y1 = x.baseY + d; x.y0 = x.y1 - h; }
      }
      group = [];
    };
    for (const x of fitted) {
      if (group.length && x.rowH > group[0].rowH * 1.15) snapGroup();
      group.push(x);
    }
    snapGroup();
    // Height is settled; now recenter each bar on its line's ink. Anchoring at
    // baseline+descenders leaves lines with no descender ink ("23°C", digits,
    // ALL CAPS) top-flush in a bar that hangs below them, and glyphs above the
    // fitted ascender (², quote marks, °) can even poke out of the bar. For
    // lines whose ink spans the full box this is a no-op, so mixed-text bars
    // keep their baseline rhythm.
    for (const { ext, bb } of lines) {
      if (!ext || !ext.rowH || !bb) continue;
      const half = (ext.y1 - ext.y0) / 2;
      const mid = (bb.y0 + bb.y1) / 2;
      ext.y0 = mid - half;
      ext.y1 = mid + half;
    }
    let words = [];
    for (const { ext, ws } of lines)
      for (const w of ws) {
        const lb = ext || w.bbox;
        words.push({ text: w.text, bbox: w.bbox, lineY0: lb.y0, lineY1: lb.y1 });
      }
    if (!words.length)
      words = (data.words || [])
        .filter((w) => w.text && w.text.trim() && w.bbox)
        .map((w) => ({ text: w.text, bbox: w.bbox, lineY0: w.bbox.y0, lineY1: w.bbox.y1 }));
    return { text: (data.text || '').trim(), words };
  } finally {
    await worker.terminate();
  }
});


// ---------------------------------------------------------------- selftest
// `electron . --selftest <image.png>` loads the image as if it were the captured
// region, auto-runs OCR in the result window, prints the text to stdout and exits.

ipcMain.on('selftest-ocr-done', async (e, { text, words }) => {
  console.log('SELFTEST_WORDS=' + words);
  console.log('SELFTEST_TEXT_BEGIN');
  console.log(text);
  console.log('SELFTEST_TEXT_END');
  // SELFTEST_SHOT=<path.png>: also save a screenshot of the result window with
  // the text layer visible, for eyeballing the overlay without manual UI
  if (process.env.SELFTEST_SHOT) {
    try {
      await new Promise((r) => setTimeout(r, 300)); // let the text layer paint
      e.sender.invalidate(); // force a fresh composite — capturePage can return a stale frame
      await new Promise((r) => setTimeout(r, 200));
      const shot = await e.sender.capturePage();
      fs.writeFileSync(process.env.SELFTEST_SHOT, shot.toPNG());
      console.log('SELFTEST_SHOT=' + process.env.SELFTEST_SHOT);
    } catch (err) {
      console.error('SELFTEST_SHOT_ERROR: ' + err);
    }
  }
  app.isQuitting = true;
  app.quit();
});

ipcMain.on('selftest-ocr-error', (e, msg) => {
  console.error('SELFTEST_ERROR: ' + msg);
  app.isQuitting = true;
  app.exit(1);
});

// ---------------------------------------------------------------- app

// Test runs must never drive an instance the user already has running: merely
// *asking* for the lock makes the primary fire 'second-instance' (which starts a
// capture — a fullscreen overlay the user then has to Esc away), so --selftest
// and --test-capture skip the request entirely and run beside it.
const TEST_MODE = SELFTEST || TEST_CAPTURE;
const gotLock = TEST_MODE || app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', (e, argv) => {
    // belt and braces for the same thing, from the primary's side
    if (argv.includes('--selftest') || argv.includes('--test-capture')) return;
    startCapture();
  });

  app.whenReady().then(() => {
    createLauncher();
    if (TEST_CAPTURE) {
      startCapture();
    } else if (!SELFTEST) {
      createTray();
      if (!globalShortcut.register(HOTKEY, () => startCapture())) {
        console.warn(`Could not register global hotkey ${HOTKEY}`);
      }
    } else {
      const img = nativeImage.createFromPath(path.resolve(SELFTEST_IMAGE));
      if (img.isEmpty()) {
        console.error('SELFTEST_ERROR: could not load image ' + SELFTEST_IMAGE);
        app.exit(1);
        return;
      }
      openResult(img, 1, { x: 100, y: 100, w: img.getSize().width, h: img.getSize().height });
    }
  });

  app.on('before-quit', () => {
    // any quit request (tray, OS shutdown, dev-reload) must win over the
    // launcher's minimize-to-tray close handler
    app.isQuitting = true;
  });

  app.on('window-all-closed', () => {
    // stay in tray; quit only via tray menu (or in selftest)
    if (SELFTEST) app.quit();
  });

  app.on('will-quit', () => globalShortcut.unregisterAll());
}
