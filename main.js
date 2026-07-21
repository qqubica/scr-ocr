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
} = require('electron');
const path = require('path');
const fs = require('fs');

const HOTKEY = 'Control+Alt+S';
// Tesseract language(s), '+'-separated. Traineddata is downloaded on first OCR
// and cached in the app's user-data folder, so later runs work offline.
const OCR_LANGS = 'eng+pol';

let tray = null;
let launcherWin = null;
let overlayWins = [];
// displayId -> { image: NativeImage, scaleFactor, bounds }
let captures = new Map();
let capturing = false;

const selftestArg = process.argv.indexOf('--selftest');
const SELFTEST = selftestArg !== -1;
const SELFTEST_IMAGE = SELFTEST ? process.argv[selftestArg + 1] : null;
const TEST_CAPTURE = process.argv.includes('--test-capture');

// ---------------------------------------------------------------- launcher

function createLauncher() {
  launcherWin = new BrowserWindow({
    width: 380,
    height: 240,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    show: !SELFTEST && !TEST_CAPTURE,
    icon: path.join(__dirname, 'assets', 'icon.png'),
    webPreferences: { nodeIntegration: true, contextIsolation: false },
  });
  launcherWin.removeMenu();
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
  tray.setToolTip(`SCR-OCR — area screenshot + OCR (${HOTKEY.replace(/Control/, 'Ctrl')})`);
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: `Take screenshot\t${HOTKEY.replace(/Control/, 'Ctrl')}`, click: () => startCapture() },
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

async function startCapture() {
  if (capturing || overlayWins.length) return;
  capturing = true;
  try {
    const launcherWasVisible = launcherWin && launcherWin.isVisible();
    if (launcherWasVisible) {
      launcherWin.hide();
      // give the compositor a beat to actually remove the window
      await new Promise((r) => setTimeout(r, 180));
    }

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

ipcMain.on('launcher-capture', () => startCapture());

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
  openResult(cropped, sf, {
    x: cap.bounds.x + rect.x,
    y: cap.bounds.y + rect.y,
    w: rect.w,
    h: rect.h,
  });
});

// ---------------------------------------------------------------- result

function openResult(image, scaleFactor, screenRect) {
  const png = image.toPNG();
  const size = image.getSize();
  const cssW = Math.round(size.width / scaleFactor);
  const cssH = Math.round(size.height / scaleFactor);

  const TOOLBAR = 52;
  const MIN_W = 560;
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
    frame: false,
    resizable: false,
    skipTaskbar: false,
    alwaysOnTop: true,
    show: false,
    icon: path.join(__dirname, 'assets', 'icon.png'),
    webPreferences: { nodeIntegration: true, contextIsolation: false },
  });
  win.removeMenu();
  win.loadFile('result.html', { query: SELFTEST ? { selftest: '1' } : {} });
  win.webContents.once('did-finish-load', () => {
    win.webContents.send('result-init', {
      pngBase64: png.toString('base64'),
      cssW,
      cssH,
      physW: size.width,
      physH: size.height,
    });
  });
  win.once('ready-to-show', () => win.show());
}

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
    let words = data.words;
    if (!words || !words.length) {
      words = [];
      for (const block of data.blocks || [])
        for (const par of block.paragraphs || [])
          for (const line of par.lines || [])
            for (const w of line.words || []) words.push(w);
    }
    words = (words || [])
      .filter((w) => w.text && w.text.trim() && w.bbox)
      .map((w) => ({ text: w.text, bbox: w.bbox }));
    return { text: (data.text || '').trim(), words };
  } finally {
    await worker.terminate();
  }
});


// ---------------------------------------------------------------- selftest
// `electron . --selftest <image.png>` loads the image as if it were the captured
// region, auto-runs OCR in the result window, prints the text to stdout and exits.

ipcMain.on('selftest-ocr-done', (e, { text, words }) => {
  console.log('SELFTEST_WORDS=' + words);
  console.log('SELFTEST_TEXT_BEGIN');
  console.log(text);
  console.log('SELFTEST_TEXT_END');
  app.isQuitting = true;
  app.quit();
});

ipcMain.on('selftest-ocr-error', (e, msg) => {
  console.error('SELFTEST_ERROR: ' + msg);
  app.isQuitting = true;
  app.exit(1);
});

// ---------------------------------------------------------------- app

const gotLock = app.requestSingleInstanceLock();
if (!gotLock && !SELFTEST) {
  app.quit();
} else {
  app.on('second-instance', () => startCapture());

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

  app.on('window-all-closed', () => {
    // stay in tray; quit only via tray menu (or in selftest)
    if (SELFTEST) app.quit();
  });

  app.on('will-quit', () => globalShortcut.unregisterAll());
}
