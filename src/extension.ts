import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { TokenManager } from './auth';
import { EventBus, registerStandardEvents } from './events';
import { InstancesRegistry, type InstanceRecord } from './instances';
import { Logger, type LogLevel } from './logger';
import { EndpointRegistry, type EndpointDefinition } from './registry';
import { Serializer } from './serializer';
import { InternalsServer } from './server';
import { registerAllBuiltinRoutes, registerDevRoutes } from './routes';

const EXTENSION_VERSION: string = (() => {
  const pkgPath = path.join(__dirname, '..', 'package.json');
  return JSON.parse(fs.readFileSync(pkgPath, 'utf8')).version;
})();
const OUTPUT_CHANNEL_NAME = 'VSCode Internals';
const CORE_OWNER_ID = 'core';

let logger: Logger | undefined;
let server: InternalsServer | undefined;
let registry: EndpointRegistry | undefined;
let serializer: Serializer | undefined;
let events: EventBus | undefined;
let tokens: TokenManager | undefined;
let statusBar: vscode.StatusBarItem | undefined;
let instances: InstancesRegistry | undefined;
/** ISO timestamp set once at activate(); used as the creation date for the global instances.json entry and /health.startedAt. */
let startedAt: string | undefined;

/**
 * Public API surface — what `extension.exports` exposes to other extensions.
 * Stable contract; treat as semver.
 */
export interface VSCodeInternalsAPI {
  /** Current bearer token. Other extensions can use this to self-test or to issue local requests. */
  getToken(): Promise<string>;
  /** Server base URL (e.g. http://127.0.0.1:7891). */
  getServerUrl(): string;
  /**
   * Register an endpoint. Endpoints registered here participate in OpenAPI, auth, and the same
   * dispatcher as built-in routes. Returns a disposable; disposing unregisters.
   */
  registerEndpoint(def: EndpointDefinition): vscode.Disposable;
}

export async function activate(context: vscode.ExtensionContext): Promise<VSCodeInternalsAPI> {
  const config = readConfig();
  logger = new Logger(OUTPUT_CHANNEL_NAME, config.logLevel);
  logger.info('Activating VSCode Internals', { version: EXTENSION_VERSION });

  registry = new EndpointRegistry();
  serializer = new Serializer();
  events = new EventBus(logger);
  registerStandardEvents(events, serializer);
  tokens = new TokenManager(context.secrets);
  instances = new InstancesRegistry(logger);
  startedAt = new Date().toISOString();

  server = new InternalsServer(
    { registry, serializer, tokens, events, logger },
    {
      port: config.port,
      host: config.host,
      maxBodySizeBytes: config.maxBodySizeBytes,
      version: EXTENSION_VERSION,
      portAutoIncrement: config.portAutoIncrement,
      portAutoIncrementMax: config.portAutoIncrementMax,
      startedAt,
    },
  );

  const devMode = isDevModeActive(context, config);

  registerAllBuiltinRoutes(registry, CORE_OWNER_ID);
  if (devMode) {
    registerDevRoutes(registry, CORE_OWNER_ID, { events, logger, registry });
    const reason = context.extensionMode === vscode.ExtensionMode.Development
      ? 'extensionMode=Development'
      : 'vscodeInternals.devMode=true';
    logger.warn(`Dev routes enabled (/dev/eval, /dev/info) — ${reason}`);
  }
  logger.info(`Registered ${registry.list().length} built-in endpoints`);

  // Make sure a token exists before binding — the SecretStorage call is async.
  const initialToken = await tokens.getOrCreate();

  if (config.autoStart) {
    try {
      await server.start();
      if (config.showStartupNotifications) {
        warnIfNonLoopback(config.host);
        notifyIfPortBumped(config.port, server.port);
      }
      await registerInstance(instances, server, startedAt, logger);
    } catch (err) {
      logger.error('Failed to start server', err);
      void vscode.window.showErrorMessage(
        `VSCode Internals: failed to start server on ${config.host}:${config.port}. ${(err as Error).message}`,
      );
    }
  }

  // Drop the token + base URL to a well-known temp file so a local E2E runner can
  // pick them up without a user round-trip. Written AFTER start() so the recorded
  // URL reflects any port bump that happened. Only written when dev mode is active
  // — never for plain marketplace installs.
  if (devMode) {
    writeDevHandshakeFile(initialToken, server.url, server.port, logger);
  }

  if (config.showStatusBar) createStatusBar(context);
  registerCommands(context, devMode);
  registerConfigWatcher(context);

  context.subscriptions.push({
    dispose: () => {
      // Subscription disposables are best-effort and may not be awaited by the
      // host on shutdown. The async unregister + server.stop work happens in the
      // exported `deactivate()` below, which VSCode reliably awaits.
      events?.dispose();
      statusBar?.dispose();
    },
  });

  return {
    async getToken() { return tokens!.getOrCreate(); },
    getServerUrl() { return server!.url; },
    registerEndpoint(def: EndpointDefinition): vscode.Disposable {
      // Use the calling extension's ID as the owner so we can clean up on deactivation.
      const ownerId = inferCallerExtensionId(context) ?? 'third-party';
      registry!.register(def, ownerId);
      return {
        dispose: () => {
          registry!.unregister(def.method, def.path);
        },
      };
    },
  };
}

export async function deactivate(): Promise<void> {
  // VSCode awaits the Promise returned here before tearing down the extension
  // host, so this is the reliable place for async cleanup. We bound the
  // unregister with a tight timeout in case the global lock is contended —
  // a stale entry on disk is acceptable (next boot prunes by pid) but blocking
  // shutdown is not.
  logger?.info('Deactivating');
  try {
    await Promise.race([
      instances?.unregister(vscode.env.sessionId) ?? Promise.resolve(),
      new Promise<void>((resolve) => setTimeout(resolve, 500)),
    ]);
  } catch (err) {
    logger?.debug(`Failed to unregister instance: ${(err as Error).message}`);
  }
  try {
    await server?.stop();
  } catch (err) {
    logger?.debug(`server.stop threw: ${(err as Error).message}`);
  }
  logger?.dispose();
}

interface RuntimeConfig {
  port: number;
  host: string;
  autoStart: boolean;
  maxBodySizeBytes: number;
  logLevel: LogLevel;
  portAutoIncrement: boolean;
  portAutoIncrementMax: number;
  devMode: boolean;
  showStatusBar: boolean;
  showStartupNotifications: boolean;
}

function readConfig(): RuntimeConfig {
  const c = vscode.workspace.getConfiguration('vscodeInternals');
  const envPort = parseInt(process.env.VSCODE_INTERNALS_PORT ?? '', 10);
  const envHost = process.env.VSCODE_INTERNALS_HOST;
  return {
    port: Number.isFinite(envPort) ? envPort : c.get<number>('port', 7891),
    host: envHost && envHost.length > 0 ? envHost : c.get<string>('host', '127.0.0.1'),
    autoStart: c.get<boolean>('autoStart', true),
    maxBodySizeBytes: c.get<number>('maxBodySizeBytes', 10 * 1024 * 1024),
    logLevel: c.get<LogLevel>('logLevel', 'info'),
    portAutoIncrement: c.get<boolean>('portAutoIncrement', true),
    portAutoIncrementMax: c.get<number>('portAutoIncrementMax', 20),
    devMode: c.get<boolean>('devMode', false),
    showStatusBar: c.get<boolean>('showStatusBar', true),
    showStartupNotifications: c.get<boolean>('showStartupNotifications', true),
  };
}

/**
 * True if dev features should be enabled — either VSCode launched us as an Extension
 * Development Host, OR the user opted in via `vscodeInternals.devMode`. Dev features
 * include `/dev/eval` (arbitrary code execution), `/dev/info`, the `vscodeInternals.restart`
 * command, and the dev-handshake file.
 */
function isDevModeActive(context: vscode.ExtensionContext, config: RuntimeConfig): boolean {
  return context.extensionMode === vscode.ExtensionMode.Development || config.devMode;
}

function warnIfNonLoopback(host: string): void {
  if (host !== '127.0.0.1' && host !== 'localhost' && host !== '::1') {
    void vscode.window.showWarningMessage(
      `VSCode Internals is bound to ${host} — non-loopback addresses expose your editor to the network. ` +
      `Anyone reaching this port and obtaining the token can drive your VSCode.`,
    );
  }
}

function notifyIfPortBumped(configuredPort: number, actualPort: number): void {
  if (actualPort === configuredPort) return;
  void vscode.window.showInformationMessage(
    `VSCode Internals: port ${configuredPort} was in use, bound to ${actualPort} instead. ` +
    `Use the status bar or "Show Server Status" command to copy the current URL.`,
  );
}

function createStatusBar(context: vscode.ExtensionContext): void {
  statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBar.command = 'vscodeInternals.showStatus';
  updateStatusBar();
  statusBar.show();
  context.subscriptions.push(statusBar);
}

function updateStatusBar(): void {
  if (!statusBar) return;
  if (server) {
    statusBar.text = `$(plug) Internals ${server.url.replace(/^https?:\/\//, '')}`;
    statusBar.tooltip = `VSCode Internals API — click for status\nServer: ${server.url}`;
  } else {
    statusBar.text = '$(plug) Internals: off';
    statusBar.tooltip = 'VSCode Internals API not running — click for status';
  }
}

function registerCommands(context: vscode.ExtensionContext, devMode: boolean): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('vscodeInternals.showToken', async () => {
      const token = await tokens!.getOrCreate();
      const pick = await vscode.window.showInformationMessage(
        `Token: ${token.slice(0, 14)}…${token.slice(-6)}`,
        'Copy to Clipboard',
        'Reveal Full Token',
      );
      if (pick === 'Copy to Clipboard') {
        await vscode.env.clipboard.writeText(token);
        void vscode.window.showInformationMessage('Token copied to clipboard.');
      } else if (pick === 'Reveal Full Token') {
        logger?.show();
        logger?.info(`Bearer token: ${token}`);
      }
    }),

    vscode.commands.registerCommand('vscodeInternals.copyToken', async () => {
      const token = await tokens!.getOrCreate();
      await vscode.env.clipboard.writeText(token);
      void vscode.window.showInformationMessage('VSCode Internals token copied to clipboard.');
    }),

    vscode.commands.registerCommand('vscodeInternals.regenerateToken', async () => {
      const confirm = await vscode.window.showWarningMessage(
        'Regenerate the bearer token? Any client using the current token will stop working.',
        { modal: true },
        'Regenerate',
      );
      if (confirm !== 'Regenerate') return;
      const fresh = await tokens!.regenerate();
      await vscode.env.clipboard.writeText(fresh);
      void vscode.window.showInformationMessage('Token regenerated and copied to clipboard.');
    }),

    vscode.commands.registerCommand('vscodeInternals.openDocs', async () => {
      if (!server) {
        void vscode.window.showErrorMessage('Server is not running.');
        return;
      }
      await vscode.env.openExternal(vscode.Uri.parse(`${server.url}/docs`));
    }),

    vscode.commands.registerCommand('vscodeInternals.showStatus', async () => {
      const lines = [
        `Server: ${server ? server.url : 'not running'}`,
        `Endpoints registered: ${registry?.list().length ?? 0}`,
        `Event sources: ${events?.listAvailable().length ?? 0}`,
      ];
      const pick = await vscode.window.showInformationMessage(lines.join('\n'), 'Open Docs', 'Show Token', 'Show Log');
      if (pick === 'Open Docs') void vscode.commands.executeCommand('vscodeInternals.openDocs');
      else if (pick === 'Show Token') void vscode.commands.executeCommand('vscodeInternals.showToken');
      else if (pick === 'Show Log') logger?.show();
    }),
  );

  // Soft-restart the HTTP server in place. Gated behind dev mode (either
  // extensionMode=Development or vscodeInternals.devMode=true) because it's
  // primarily a test-harness affordance (lets the E2E runner cycle the server
  // without reloading the entire VSCode window). End users should use the
  // standard "Reload Window" command after changing port/host settings.
  if (devMode) {
    context.subscriptions.push(
      vscode.commands.registerCommand('vscodeInternals.restart', async () => {
        // Schedule the work on the next tick so a caller invoking this via the HTTP API
        // (POST /commands/execute) gets its response before the server socket is torn down.
        // Awaiting server.stop() inline would block on the same connection.
        const restart = async () => {
          await server?.stop();
          const config = readConfig();
          logger?.setLevel(config.logLevel);
          server = new InternalsServer(
            { registry: registry!, serializer: serializer!, tokens: tokens!, events: events!, logger: logger! },
            {
              port: config.port,
              host: config.host,
              maxBodySizeBytes: config.maxBodySizeBytes,
              version: EXTENSION_VERSION,
              portAutoIncrement: config.portAutoIncrement,
              portAutoIncrementMax: config.portAutoIncrementMax,
              startedAt: startedAt!,
            },
          );
          try {
            await server.start();
            if (config.showStartupNotifications) {
              warnIfNonLoopback(config.host);
              notifyIfPortBumped(config.port, server.port);
            }
            await registerInstance(instances!, server, startedAt!, logger!);
            updateStatusBar();
            void vscode.window.showInformationMessage(`VSCode Internals restarted on ${server.url}`);
          } catch (err) {
            void vscode.window.showErrorMessage(`Restart failed: ${(err as Error).message}`);
          }
        };
        setImmediate(restart);
        return { restarting: true };
      }),
    );
  }
}

function registerConfigWatcher(context: vscode.ExtensionContext): void {
  // Keys that only take effect at activation time — toggling them at runtime
  // requires a window reload to rebuild routes, the status bar, the server, etc.
  const RELOAD_REQUIRED_KEYS = [
    'vscodeInternals.port',
    'vscodeInternals.host',
    'vscodeInternals.maxBodySizeBytes',
    'vscodeInternals.portAutoIncrement',
    'vscodeInternals.portAutoIncrementMax',
    'vscodeInternals.devMode',
    'vscodeInternals.showStatusBar',
    'vscodeInternals.autoStart',
  ];

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration('vscodeInternals')) return;
      const cfg = readConfig();
      logger?.setLevel(cfg.logLevel);
      if (RELOAD_REQUIRED_KEYS.some((k) => e.affectsConfiguration(k))) {
        void vscode.window
          .showInformationMessage(
            'VSCode Internals: server settings changed. Reload the window to apply.',
            'Reload Window',
          )
          .then((p) => {
            if (p === 'Reload Window') void vscode.commands.executeCommand('workbench.action.reloadWindow');
          });
      }
    }),
  );
}

/**
 * Best-effort attempt to identify the calling extension. VSCode does not expose a
 * synchronous "who is calling me right now" mechanism, so this is intentionally heuristic.
 * Endpoints registered without a clear caller are tagged 'third-party' and grouped together.
 */
function inferCallerExtensionId(_ctx: vscode.ExtensionContext): string | undefined {
  // Placeholder. The cleanest pattern is for the caller to pass their extension ID
  // alongside the endpoint definition; future API revisions can require that.
  return undefined;
}

/**
 * Insert/refresh this window's entry in the global instances registry
 * (`~/.vscode-internals/instances.json`). Best-effort — never throws.
 * Called after a successful server.start() so the recorded port reflects
 * any auto-bump, and again on every soft-restart.
 */
async function registerInstance(
  reg: InstancesRegistry,
  srv: InternalsServer,
  started: string,
  log: Logger,
): Promise<void> {
  try {
    const folders = vscode.workspace.workspaceFolders ?? [];
    const rec: InstanceRecord = {
      sessionId: vscode.env.sessionId,
      pid: process.pid,
      host: new URL(srv.url).hostname,
      port: srv.port,
      url: srv.url,
      appName: vscode.env.appName,
      appHost: vscode.env.appHost,
      remoteName: vscode.env.remoteName ?? null,
      workspaceName: vscode.workspace.name ?? null,
      workspaceFolders: folders.map((f) => f.uri.fsPath),
      extensionVersion: EXTENSION_VERSION,
      vscodeVersion: vscode.version,
      startedAt: started,
    };
    await reg.register(rec);
    log.debug(`Registered instance ${rec.sessionId} → ${rec.url}`);
  } catch (err) {
    log.warn(`Failed to register instance: ${(err as Error).message}`);
  }
}

/**
 * Dev-only: write {url, token} JSON to `<tmpdir>/niradler.vscode-internals.dev.json`
 * so a local E2E script can talk to a freshly-launched Extension Development Host
 * without prompting the user. Never called in production.
 *
 * Called AFTER `server.start()` so `url`/`port` reflect any port auto-bump.
 */
function writeDevHandshakeFile(token: string, url: string, port: number, log: Logger): void {
  try {
    const file = path.join(os.tmpdir(), 'niradler.vscode-internals.dev.json');
    const payload = {
      url,
      port,
      token,
      pid: process.pid,
      writtenAt: new Date().toISOString(),
    };
    fs.writeFileSync(file, JSON.stringify(payload, null, 2), { mode: 0o600 });
    log.info(`Dev handshake written to ${file}`);
  } catch (err) {
    log.warn('Failed to write dev handshake file', err);
  }
}
