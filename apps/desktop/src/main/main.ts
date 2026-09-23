import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, session, shell } from 'electron';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  API_ENDPOINTS,
  Datera,
  DateraError,
  type AddSourceRequest,
  type ModelDescriptor,
  type PreviewOptions,
} from '@datera/core';
import {
  ConsoleLogger,
  NodeFileSystem,
  SystemClock,
  NodeHttp,
  NodeLocalLlm,
  nodeDuckDBDriver,
  resolveExtensionDirectory,
  unpackExtensions,
} from '@datera/node-runtime';
import { IPC, type SerialisedError } from '../shared/contract.js';
import { SafeStorageSecretStore, secretStorePath } from './secret-store.js';

const here = resolve(fileURLToPath(import.meta.url), '..');
const distRoot = resolve(here, '..');
const appRoot = resolve(distRoot, '..');

/**
 * The Electron main process — a thin host over @datera/core (spec §2, invariant §1.7).
 *
 * Main owns the single core instance. The renderer never imports the core, never touches
 * Node, and reaches the engine only through the typed IPC contract. That keeps the core
 * out of a sandboxed browser context and means the same contract can later be fulfilled
 * by an HTTP client pointed at a Datera Server (acceptance §12.10).
 */

const APP_NAME = 'Datera';

/**
 * Set before anything else, and before `whenReady`.
 *
 * Electron defaults `app.name` to package.json's `name`, which here is the scoped package
 * "@datera/desktop" — a build detail, shown to the user in the menu bar and the About
 * panel. It has to be set this early because the menu and the dock read it during startup.
 *
 * This fixes the *running* process. The packaged bundle takes its name from
 * electron-builder's `productName`, which is set in package.json — see the identity test.
 */
app.setName(APP_NAME);

/**
 * A test run gets its own profile, beside its own workspace.
 *
 * Every Electron test isolated its *workspace* with DATERA_WORKSPACE and none isolated the
 * *profile* — so each one wrote Chromium caches, and a models directory, into the real
 * ~/Library/Application Support/Datera. Found when a clean reset was undone by the very
 * smoke test run to check the reinstall. Set here, before 'ready', because that is the
 * only point at which Electron honours it.
 */
if (process.env['DATERA_HEADLESS'] === '1' && process.env['DATERA_WORKSPACE'] !== undefined) {
  app.setPath('userData', join(resolve(process.env['DATERA_WORKSPACE']), '.profile'));
}

let datera: Datera | null = null;
let window: BrowserWindow | null = null;

function defaultWorkspacePath(): string {
  const fromEnv = process.env['DATERA_WORKSPACE'];
  if (fromEnv !== undefined && fromEnv.length > 0) return resolve(fromEnv);
  return join(app.getPath('userData'), 'workspaces', 'default');
}

async function openCore(): Promise<Datera> {
  const workspacePath = defaultWorkspacePath();
  return Datera.open({
    workspacePath,
    driver: nodeDuckDBDriver(),
    ports: {
      fs: new NodeFileSystem(),
      clock: new SystemClock(),
      logger: new ConsoleLogger({ minLevel: 'info' }),
      secrets: new SafeStorageSecretStore(secretStorePath(workspacePath)),
      // The desktop client is allowed to reach model providers the user has chosen.
      // Datera Server will supply its own, env-configured (spec §9).
      http: new NodeHttp(),
      // Weights live in the app's data directory, not the workspace: they are machine
      // state, shared across workspaces, and nobody wants two gigabytes copied when they
      // move a project folder.
      llm: new NodeLocalLlm({
        directory: join(app.getPath('userData'), 'models'),
        // Weights shipped inside the installer, for the offline build. Read in place: an
        // app bundle is not writable, and copying two gigabytes to use them would be
        // both slow and pointless.
        seedDirectory: app.isPackaged ? join(process.resourcesPath, 'models') : join(appRoot, 'models'),
      }),
    },
    // Packaged: the extensions ship gzipped (codesign refuses a .duckdb_extension, which
    // is a Mach-O library with metadata appended) and are unpacked into the app's data
    // directory on first run. Unpackaged: found by walking up from the app root.
    //
    // Getting this wrong in a packaged build is silent — xlsx and SQLite simply stop
    // working — so the packaged smoke test asserts both extensions actually load.
    extensionDirectory: app.isPackaged
      ? unpackExtensions(
          join(process.resourcesPath, 'extensions-packed'),
          join(app.getPath('userData'), 'duckdb-extensions'),
        )
      : resolveExtensionDirectory(appRoot),
    appVersion: app.getVersion(),
  });
}

function serialiseError(e: unknown): SerialisedError {
  if (e instanceof DateraError) {
    return {
      __dateraError: true,
      code: e.code,
      message: e.message,
      details: { ...e.details },
    };
  }
  return {
    __dateraError: true,
    code: 'UNKNOWN',
    message: e instanceof Error ? e.message : String(e),
    details: {},
  };
}

/**
 * Wrap a handler so a thrown DateraError arrives at the renderer with its code intact.
 *
 * Electron reduces a thrown Error to its message across IPC, which would lose the code the
 * UI needs to distinguish "this is read-only" from "that file moved".
 */
function handle<A extends unknown[], T>(channel: string, fn: (...args: A) => Promise<T>): void {
  ipcMain.handle(channel, async (_event, ...args: unknown[]) => {
    try {
      return { ok: true as const, value: await fn(...(args as A)) };
    } catch (e) {
      return { ok: false as const, error: serialiseError(e) };
    }
  });
}

function core(): Datera {
  if (datera === null) throw new Error('The Datera engine is not open yet.');
  return datera;
}

function registerHandlers(): void {
  handle(IPC.engineInfo, async () => core().engineInfo());
  handle(IPC.listDatasets, async () => core().listDatasets());
  handle(IPC.listSources, async () => core().listSources());
  handle(IPC.addSource, async (request: AddSourceRequest) => core().addSource(request));
  handle(IPC.removeSource, async (id: string) => core().removeSource(id));
  handle(IPC.getSchema, async (sourceId: string) => core().getSchema(sourceId));
  handle(IPC.preview, async (sourceId: string, options?: PreviewOptions) =>
    core().preview(sourceId, options ?? {}),
  );
  handle(IPC.query, async (datasetId: string, sql: string) => core().query(datasetId, sql));
  handle(IPC.ask, async (datasetId: string, question: string, opts?: { topK?: number }) =>
    core().ask(datasetId, question, opts ?? {}),
  );
  handle(IPC.listModels, async () => core().listModels());
  handle(IPC.downloadBundledModel, async (modelId: string) =>
    core().downloadBundledModel(modelId, (progress) => {
      // Streamed to the renderer rather than returned: a two-gigabyte download with no
      // visible progress is indistinguishable from a hang, and #33 is already the bug
      // report for "it looks frozen".
      window?.webContents.send(IPC.bundledProgress, { modelId, ...progress });
    }),
  );
  handle(IPC.removeBundledModel, async (modelId: string) => core().removeBundledModel(modelId));
  handle(IPC.warmChatModel, async () => core().warmChatModel());
  handle(IPC.setChatModel, async (model: ModelDescriptor) => core().setChatModel(model));
  handle(IPC.setApiKey, async (provider: string, key: string) => core().setApiKey(provider, key));
  handle(IPC.hasApiKey, async (provider: string) => core().hasApiKey(provider));
  handle(IPC.clearApiKey, async (provider: string) => core().clearApiKey(provider));
  handle(IPC.draftDictionary, async (sourceId: string) => core().draftDictionary(sourceId));
  handle(IPC.getDictionary, async (sourceId: string) => core().getDictionary(sourceId));
  handle(IPC.confirmColumn, async (sourceId: string, d: never) => core().confirmColumn(sourceId, d));
  handle(IPC.confirmColumns, async (sourceId: string, d: never) => core().confirmColumns(sourceId, d));
  handle(IPC.schemaGraph, async (datasetId: string) => core().schemaGraph(datasetId));
  handle(IPC.confirmEntity, async (sourceId: string, d: never) => core().confirmEntity(sourceId, d));
  handle(IPC.detectRelationships, async (datasetId: string) => core().detectRelationships(datasetId));
  handle(IPC.confirmRelationship, async (datasetId: string, p: never) => core().confirmRelationship(datasetId, p));
  handle(IPC.listRelationships, async (datasetId?: string) => core().listRelationships(datasetId));
  handle(IPC.createDataset, async (input: never) => core().createDataset(input));
  handle(IPC.explainTouched, async (datasetId: string, sql: string, rows?: number) =>
    core().explainTouched(datasetId, sql, rows ?? 0),
  );
  handle(IPC.setEmbeddingModel, async (m: ModelDescriptor) => core().setEmbeddingModel(m));
  handle(IPC.buildEmbeddings, async (datasetId: string) => core().buildEmbeddings(datasetId));
  handle(IPC.semanticSearch, async (datasetId: string, text: string, k?: number) =>
    core().semanticSearch(datasetId, text, k ?? 5),
  );
  handle(IPC.embeddingStatus, async (datasetId: string) => core().embeddingStatus(datasetId));
  handle(IPC.listTools, async () => core().listTools());
  handle(IPC.createOperation, async (input: never) => core().createOperation(input));
  handle(IPC.listOperations, async (datasetId?: string) => core().listOperations(datasetId));
  handle(IPC.deleteOperation, async (id: string) => core().deleteOperation(id));
  handle(IPC.callOperation, async (datasetId: string, name: string, args?: never) =>
    core().callOperation(datasetId, name, args ?? {}),
  );
  handle(IPC.callTool, async (name: string, args: Record<string, unknown>) => core().callTool(name, args));
  handle(IPC.connectConfig, async (client: never, opts?: never) => core().connectConfig(client, opts ?? {}));
  handle(IPC.queryTraceLog, async (query: never) => core().queryTraceLog(query ?? {}));
  handle(IPC.getTraceRetention, async () => core().getTraceRetention());
  handle(IPC.setTraceRetention, async (policy: never) => core().setTraceRetention(policy));
  handle(IPC.getTracePayloadCapture, async () => core().getTracePayloadCapture());
  handle(IPC.setTracePayloadCapture, async (enabled: boolean) => core().setTracePayloadCapture(enabled));
  handle(IPC.pruneTraceLog, async () => core().pruneTraceLog());
  handle(IPC.listEnvironments, async () => core().listEnvironments());
  handle(IPC.listReachableDatasets, async () => core().listReachableDatasets());
  handle(IPC.environmentStatuses, async () => core().environmentStatuses());
  handle(IPC.addEnvironment, async (input: never) => core().addEnvironment(input));
  handle(IPC.removeEnvironment, async (id: string) => core().removeEnvironment(id));
  handle(IPC.pushDataset, async (datasetId: string, envId: string) => core().pushDataset(datasetId, envId));
  handle(IPC.moveSource, async (sourceId: string, target: string) => core().moveSource(sourceId, target));
  handle(IPC.renameDataset, async (id: string, name: string) => core().renameDataset(id, name));
  handle(IPC.deleteDataset, async (id: string) => core().deleteDataset(id));
  handle(IPC.apiEndpoints, async () => API_ENDPOINTS);
  handle(IPC.deriveDataset, async (id: string, input: never) => core().deriveDataset(id, input));
  handle(IPC.proposeNormalization, async (sourceId: string) => core().proposeNormalization(sourceId));
  handle(IPC.applyNormalization, async (id: string, p: never, input: never) => core().applyNormalization(id, p, input));
  handle(IPC.proposeEnums, async (sourceId: string) => core().proposeEnums(sourceId));
  handle(IPC.saveVersion, async (id: string, label: string) => core().saveVersion(id, label));
  handle(IPC.listVersions, async (id: string) => core().listVersions(id));
  handle(IPC.diffVersions, async (a: string, b: string) => core().diffVersions(a, b));
  handle(IPC.exportDataset, async (id: string, dir: string, opts?: never) => core().exportDataset(id, dir, opts ?? {}));
  handle(IPC.importDataset, async (dir: string) => core().importDataset(dir));
  handle(IPC.canWrite, async (id: string) => core().canWrite(id));
  handle(IPC.grantWrite, async (id: string) => core().grantWrite(id));
  handle(IPC.enableWrites, async (id: string) => core().enableWrites(id));
  handle(IPC.revokeWrite, async (id: string) => core().revokeWrite(id));
  handle(IPC.proposeWrite, async (id: string, sql: string) => core().proposeWrite(id, sql));
  handle(IPC.proposeWriteFromQuestion, async (id: string, q: string) => core().proposeWriteFromQuestion(id, q));
  handle(IPC.confirmWrite, async (proposalId: string) => core().confirmWrite(proposalId));
  handle(IPC.undoWrite, async (writeId: string) => core().undoWrite(writeId));
  handle(IPC.listWrites, async (id: string) => core().listWrites(id));
  handle(IPC.listTables, async (id: string) => core().listTables(id));

  handle(IPC.pickDirectory, async () => {
    // A native dialog cannot be driven by a test, which is why the export flow had no
    // end-to-end coverage at all — and why a bug that made cancelling look identical to
    // failing survived in it. Headless runs answer with a fixed directory instead.
    const scripted = process.env['DATERA_TEST_DIRECTORY'];
    if (headless && scripted !== undefined) return scripted === '' ? null : scripted;

    if (window === null) return null;
    const result = await dialog.showOpenDialog(window, {
      title: 'Choose a folder',
      properties: ['openDirectory', 'createDirectory'],
    });
    return result.canceled ? null : result.filePaths[0] ?? null;
  });
  handle(IPC.getLifecycle, async () => core().getLifecycle());
  handle(IPC.setLifecycle, async (lifecycle: never) => core().setLifecycle(lifecycle));
  handle(IPC.resetLifecycle, async () => core().resetLifecycle());
  handle(IPC.remoteQuery, async (envId: string, datasetId: string, sql: string) => {
    const client = await core().connectTo(envId);
    return client.query(datasetId, sql);
  });

  handle(IPC.pickFiles, async () => {
    if (window === null) return [];
    const result = await dialog.showOpenDialog(window, {
      title: 'Connect data',
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: 'Data', extensions: ['csv', 'tsv', 'json', 'ndjson', 'jsonl', 'parquet', 'xlsx', 'sqlite', 'db'] },
        { name: 'All files', extensions: ['*'] },
      ],
    });
    return result.canceled ? [] : result.filePaths;
  });

  handle(IPC.listWorkbookSheets, async (path: string) => core().listWorkbookSheets(path));
  handle(IPC.proposeSchema, async (text: string) => core().proposeSchema(text));
  handle(IPC.applySchema, async (datasetId: string, proposal: never) => core().applySchema(datasetId, proposal));
}

/**
 * Install an explicit application menu.
 *
 * On macOS the first menu is the *application* menu, and without a menu of our own it is
 * built from the Electron binary's bundle — which is why an unpackaged app says
 * "Electron" no matter what `app.setName` is set to.
 *
 * Owning the menu means owning all of it, so the standard roles are kept deliberately:
 * losing Copy, Paste, or Quit to a hand-rolled menu is a real regression, and they are
 * the things people reach for without looking.
 */
function installApplicationMenu(): void {
  const isMac = process.platform === 'darwin';

  const appMenu: Electron.MenuItemConstructorOptions = {
    label: APP_NAME,
    submenu: [
      { role: 'about', label: `About ${APP_NAME}` },
      { type: 'separator' },
      ...(isMac
        ? ([
            { role: 'hide', label: `Hide ${APP_NAME}` },
            { role: 'hideOthers' },
            { role: 'unhide' },
            { type: 'separator' },
          ] as Electron.MenuItemConstructorOptions[])
        : []),
      { role: 'quit', label: `Quit ${APP_NAME}` },
    ],
  };

  const template: Electron.MenuItemConstructorOptions[] = [
    appMenu,
    {
      label: 'File',
      submenu: [
        {
          label: 'Connect Data…',
          accelerator: 'CmdOrCtrl+O',
          click: () => {
            void window?.webContents.executeJavaScript(
              'window.dispatchEvent(new CustomEvent("datera:connect-data"))',
            );
          },
        },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' },
      ],
    },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    { role: 'windowMenu' },
    {
      label: 'Help',
      submenu: [
        {
          label: 'Datera on GitHub',
          click: () => {
            void shell.openExternal('https://github.com/prodxpdev/datera');
          },
        },
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function createWindow(): void {
  window = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#fbfcfd',
    title: 'Datera',
    // Rendered and laid out either way — Playwright drives it and layout assertions still
    // measure correctly — but not thrown onto the user's screen.
    show: !headless,
    // macOS takes the icon from the bundle; Windows and Linux take it from the window,
    // and a dev run on either shows the Electron default without this.
    icon: join(appRoot, 'build', 'icon.png'),
    webPreferences: {
      // The three that matter. The renderer is a browser context with no Node, no direct
      // access to the core, and no ability to reach anything except the preload bridge.
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: join(distRoot, 'preload', 'preload.cjs'),
    },
  });

  void window.loadFile(join(distRoot, 'renderer', 'index.html'));
  window.on('closed', () => {
    window = null;
  });
}

/**
 * The Dock icon, on macOS, for an unpackaged run.
 *
 * macOS ignores `BrowserWindow.icon` and reads the Dock icon from the app bundle. Running
 * `electron .` means the bundle is Electron's own, so the Dock showed the atom no matter
 * what the window or electron-builder said. A packaged build takes icon.icns and needs
 * none of this; this is purely so development and the shipped app look the same.
 */
/**
 * True when Electron was launched by the test suite.
 *
 * Tests run several app instances at once, and each one bouncing into the Dock and
 * opening a window makes the machine unusable while the suite runs. Headless keeps the
 * app fully functional — it just does not take over the screen.
 */
const headless = process.env['DATERA_HEADLESS'] === '1';

/**
 * A test instance must not outlive its test run.
 *
 * Observed: three instances wedged during window creation, ignored the suite's
 * `app.close()`, ignored SIGTERM, and were still running nearly three hours later. A
 * hung app the user has to hunt down with `kill -9` is a worse failure than the test
 * failure that caused it.
 *
 * `app.exit` rather than `app.quit`: quit is cooperative and asks windows to close, which
 * is precisely what a wedged instance will not do. The timer is unref'd so it never keeps
 * a healthy process alive on its own.
 */
function installTestWatchdog(): void {
  if (!headless) return;
  const limitMs = Number(process.env['DATERA_HEADLESS_MAX_MS'] ?? 10 * 60_000);
  setTimeout(() => {
    console.error(`[datera] headless watchdog: exiting after ${limitMs}ms`);
    app.exit(1);
  }, limitMs).unref();
}

function setDockIcon(): void {
  if (process.platform !== 'darwin' || app.dock === undefined) return;

  const image = nativeImage.createFromPath(join(appRoot, 'build', 'icon.png'));
  if (image.isEmpty()) return;

  app.dock.setIcon(image);
  // Read back by the identity test: there is no getter for the Dock icon.
  (app as unknown as { dockIconSet?: boolean }).dockIconSet = true;

  // Set, then hidden. The icon is still what the identity test asserts; it just does not
  // appear in the Dock four times over while the suite runs.
  if (headless) app.dock.hide();
}

app.whenReady().then(async () => {
  setDockIcon();
  installTestWatchdog();

  // A local-first tool has no reason to let its own UI reach the network. This is defence
  // in depth for invariant §1.6, not the mechanism: the engine's extension handling is.
  session.defaultSession.webRequest.onBeforeRequest({ urls: ['*://*/*'] }, (details, callback) => {
    callback({ cancel: !details.url.startsWith('file://') && !details.url.startsWith('devtools://') });
  });

  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': ["default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:"],
      },
    });
  });

  app.setAboutPanelOptions({
    applicationName: APP_NAME,
    applicationVersion: app.getVersion(),
    credits: 'Local-first, read-only by default. Built on DuckDB.',
  });

  installApplicationMenu();
  registerHandlers();

  try {
    datera = await openCore();
  } catch (e) {
    dialog.showErrorBox(
      'Datera could not open its workspace',
      e instanceof Error ? e.message : String(e),
    );
    app.quit();
    return;
  }

  createWindow();

  // Load a selected bundled model in the background, so the first question is not the one
  // that pays for reading two gigabytes off disk. Deliberately after the window and not
  // awaited: the UI should be usable immediately, and a failure here costs only a slower
  // first answer.
  void datera.warmChatModel().catch(() => undefined);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
}).catch((e: unknown) => {
  console.error('Failed to start Datera', e);
  app.quit();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  void datera?.close();
  datera = null;
});
