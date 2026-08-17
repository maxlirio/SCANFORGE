/**
 * SCANFORGE desktop shell.
 *
 * The app is a window onto a local API server it starts itself: a photo goes in,
 * TRELLIS.2 runs on this machine's GPU, a textured model comes out. Nothing is
 * served to the network — the server binds 127.0.0.1 on a port chosen at launch.
 *
 * Loading the renderer from that server (rather than file://) keeps everything
 * same-origin, so the viewer, uploads and progress stream work exactly as they
 * were tested.
 */
import { app, BrowserWindow, Menu, dialog, ipcMain, shell } from 'electron';
import { spawn, type ChildProcess } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
/** Packaged: Resources/app/…  Dev: <repo>/apps/desktop/dist */
const repoRoot = app.isPackaged
  ? path.join(process.resourcesPath, 'app')
  : path.resolve(here, '..', '..', '..');

const serverEntry = path.join(repoRoot, 'apps', 'server', 'dist', 'index.js');

let serverProcess: ChildProcess | null = null;
let mainWindow: BrowserWindow | null = null;
let baseUrl = '';
const pendingFiles: string[] = [];

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.unref();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

async function waitForHealth(url: string, timeoutMs = 120_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError = '';
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${url}/api/health`);
      if (res.ok) return;
      lastError = `HTTP ${res.status}`;
    } catch (err) {
      lastError = (err as Error).message;
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`the local engine did not start (${lastError})`);
}

async function startServer(): Promise<string> {
  if (!fs.existsSync(serverEntry)) {
    throw new Error(`server build missing at ${serverEntry} — run: npm run build`);
  }
  const port = await freePort();
  const dataDir = path.join(app.getPath('userData'), 'scans');
  fs.mkdirSync(dataDir, { recursive: true });

  serverProcess = spawn(process.execPath, [serverEntry], {
    cwd: repoRoot,
    env: {
      ...process.env,
      // Run the bundled Electron binary as plain Node for the child process.
      ELECTRON_RUN_AS_NODE: '1',
      NODE_ENV: 'production',
      HOST: '127.0.0.1',
      PORT: String(port),
      SCANFORGE_DATA_DIR: dataDir,
      SCANFORGE_CONCURRENCY: '1',
      LOG_LEVEL: 'warn',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let engineTail = '';
  const keep = (chunk: Buffer) => {
    engineTail = (engineTail + chunk.toString()).slice(-3000);
  };
  serverProcess.stdout?.on('data', (d) => { keep(d); process.stdout.write(`[engine] ${d}`); });
  serverProcess.stderr?.on('data', (d) => { keep(d); process.stderr.write(`[engine] ${d}`); });
  serverProcess.on('exit', (code) => {
    if (code !== 0 && !app.isQuittingForReal) {
      // Show what it actually said: an exit code alone sends people hunting in Console.
      const reason = engineTail.trim().split('\n').filter(Boolean).slice(-6).join('\n');
      dialog.showErrorBox('SCANFORGE engine stopped',
        `The local engine exited with code ${code}.\n\n${reason || 'It produced no output.'}`);
    }
  });

  const url = `http://127.0.0.1:${port}`;
  await waitForHealth(url);
  return url;
}

function createWindow(url: string): BrowserWindow {
  const win = new BrowserWindow({
    width: 1180,
    height: 820,
    minWidth: 720,
    minHeight: 560,
    title: 'SCANFORGE',
    backgroundColor: '#0b0d12',
    titleBarStyle: 'hiddenInset',
    webPreferences: {
      preload: path.join(here, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.once('ready-to-show', () => {
    win.show();
    // Dev/QA aid: capture just this window, so verifying the UI never means
    // screenshotting the user's whole desktop.
    const shot = process.env.SCANFORGE_SHOT;
    if (shot) {
      setTimeout(() => {
        void win.webContents.capturePage().then((img) =>
          fs.promises.writeFile(shot, img.toPNG()));
      }, Number(process.env.SCANFORGE_SHOT_DELAY ?? 4000));
    }
    // Files dropped on the dock icon before the window existed.
    if (pendingFiles.length) {
      win.webContents.send('scanforge:open-files', pendingFiles.splice(0),
        { generate: takeAutoGenerate() });
    }
  });
  void win.loadURL(url);

  // External links belong in the browser, not in this window.
  win.webContents.setWindowOpenHandler(({ url: target }) => {
    void shell.openExternal(target);
    return { action: 'deny' };
  });
  return win;
}

function buildMenu(): void {
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        {
          label: 'Open Scans Folder',
          click: () => void shell.openPath(path.join(app.getPath('userData'), 'scans')),
        },
        { type: 'separator' },
        { role: 'hide' }, { role: 'hideOthers' }, { type: 'separator' }, { role: 'quit' },
      ],
    },
    {
      label: 'File',
      submenu: [
        {
          label: 'Open Photo…',
          accelerator: 'CmdOrCtrl+O',
          click: () => void pickPhotos(),
        },
      ],
    },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { role: 'reload' }, { role: 'forceReload' }, { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' },
        { type: 'separator' }, { role: 'togglefullscreen' },
      ],
    },
    { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

async function pickPhotos(): Promise<string[]> {
  const result = await dialog.showOpenDialog({
    title: 'Choose a photo of your object',
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'heic', 'webp'] }],
  });
  if (result.canceled || !result.filePaths.length) return [];
  mainWindow?.webContents.send('scanforge:open-files', result.filePaths, {});
  return result.filePaths;
}

// Dragging a photo onto the dock icon.
app.on('open-file', (event, filePath) => {
  event.preventDefault();
  if (mainWindow) mainWindow.webContents.send('scanforge:open-files', [filePath], {});
  else pendingFiles.push(filePath);
});

/**
 * `SCANFORGE photo.jpg --generate` starts immediately, for scripting and tests.
 * Consumed once per launch: `ready-to-show` can fire again (a reload, a recreated
 * window), and re-arming it would silently spend another GPU run.
 */
let autoGenerateArmed = process.argv.includes('--generate');
const takeAutoGenerate = (): boolean => {
  const armed = autoGenerateArmed;
  autoGenerateArmed = false;
  return armed;
};

function argvPhotos(): string[] {
  return process.argv
    .slice(app.isPackaged ? 1 : 2)
    .filter((a) => /\.(jpe?g|png|webp|heic)$/i.test(a) && fs.existsSync(a));
}

ipcMain.handle('scanforge:pick-photos', () => pickPhotos());
ipcMain.handle('scanforge:read-file', async (_e, filePath: string) => {
  // The renderer needs the bytes to upload; it has no filesystem access itself.
  const data = await fs.promises.readFile(filePath);
  return { name: path.basename(filePath), bytes: data };
});
ipcMain.handle('scanforge:base-url', () => baseUrl);
ipcMain.handle('scanforge:reveal', (_e, target: string) => shell.showItemInFolder(target));

app.whenReady().then(async () => {
  buildMenu();
  try {
    baseUrl = await startServer();
  } catch (err) {
    dialog.showErrorBox('SCANFORGE could not start', (err as Error).message);
    app.quit();
    return;
  }
  pendingFiles.push(...argvPhotos());
  mainWindow = createWindow(baseUrl);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0 && baseUrl) {
      mainWindow = createWindow(baseUrl);
    }
  });
});

app.on('window-all-closed', () => app.quit());

app.on('before-quit', () => {
  app.isQuittingForReal = true;
  serverProcess?.kill('SIGTERM');
});

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Electron {
    interface App { isQuittingForReal?: boolean }
  }
}
