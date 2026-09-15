import { app, BrowserWindow, dialog, ipcMain, Menu, session, shell } from 'electron';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
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
  nodeDuckDBDriver,
  resolveExtensionDirectory,
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
    },
    extensionDirectory: resolveExtensionDirectory(app.isPackaged ? undefined : appRoot),
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
  handle(IPC.setChatModel, async (model: ModelDescriptor) => core().setChatModel(model));
  handle(IPC.setApiKey, async (provider: string, key: string) => core().setApiKey(provider, key));
  handle(IPC.hasApiKey, async (provider: string) => core().hasApiKey(provider));
  handle(IPC.clearApiKey, async (provider: string) => core().clearApiKey(provider));
  handle(IPC.draftDictionary, async (sourceId: string) => core().draftDictionary(sourceId));
  handle(IPC.getDictionary, async (sourceId: string) => core().getDictionary(sourceId));
  handle(IPC.confirmColumn, async (sourceId: string, d: never) => core().confirmColumn(sourceId, d));
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
  handle(IPC.callTool, async (name: string, args: Record<string, unknown>) => core().callTool(name, args));
  handle(IPC.connectConfig, async (client: never, opts?: never) => core().connectConfig(client, opts ?? {}));
  handle(IPC.queryTraceLog, async (query: never) => core().queryTraceLog(query ?? {}));
  handle(IPC.getTraceRetention, async () => core().getTraceRetention());
  handle(IPC.setTraceRetention, async (policy: never) => core().setTraceRetention(policy));
  handle(IPC.getTracePayloadCapture, async () => core().getTracePayloadCapture());
  handle(IPC.setTracePayloadCapture, async (enabled: boolean) => core().setTracePayloadCapture(enabled));
  handle(IPC.pruneTraceLog, async () => core().pruneTraceLog());
  handle(IPC.listEnvironments, async () => core().listEnvironments());
  handle(IPC.environmentStatuses, async () => core().environmentStatuses());
  handle(IPC.addEnvironment, async (input: never) => core().addEnvironment(input));
  handle(IPC.removeEnvironment, async (id: string) => core().removeEnvironment(id));
  handle(IPC.pushDataset, async (datasetId: string, envId: string) => core().pushDataset(datasetId, envId));
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

app.whenReady().then(async () => {
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
