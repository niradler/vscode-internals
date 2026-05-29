import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { TokenManager } from './auth';
import { EventBus, registerStandardEvents } from './events';
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

  server = new InternalsServer(
    { registry, serializer, tokens, events, logger },
    {
      port: config.port,
      host: config.host,
      maxBodySizeBytes: config.maxBodySizeBytes,
      version: EXTENSION_VERSION,
    },
  );

  registerAllBuiltinRoutes(registry, CORE_OWNER_ID);
  if (context.extensionMode === vscode.ExtensionMode.Development) {
    registerDevRoutes(registry, CORE_OWNER_ID, { events, logger, registry });
    logger.warn('Dev routes enabled (/dev/eval, /dev/info) — extensionMode=Development');
  }
  logger.info(`Registered ${registry.list().length} built-in endpoints`);

  // Make sure a token exists before binding — the SecretStorage call is async.
  const initialToken = await tokens.getOrCreate();

  // In Extension Development Host mode, drop the token + base URL to a well-known
  // temp file so the E2E runner can pick them up without a user round-trip.
  // Never written outside development mode.
  if (context.extensionMode === vscode.ExtensionMode.Development) {
    writeDevHandshakeFile(initialToken, config, logger);
  }

  if (config.autoStart) {
    try {
      await server.start();
      warnIfNonLoopback(config.host);
    } catch (err) {
      logger.error('Failed to start server', err);
      void vscode.window.showErrorMessage(
        `VSCode Internals: failed to start server on ${config.host}:${config.port}. ${(err as Error).message}`,
      );
    }
  }

  createStatusBar(context);
  registerCommands(context);
  registerConfigWatcher(context);

  context.subscriptions.push({
    dispose: async () => {
      logger?.info('Deactivating');
      events?.dispose();
      await server?.stop();
      statusBar?.dispose();
      logger?.dispose();
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

export function deactivate(): void {
  // Resource cleanup handled by context.subscriptions in activate().
}

interface RuntimeConfig {
  port: number;
  host: string;
  autoStart: boolean;
  maxBodySizeBytes: number;
  logLevel: LogLevel;
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
  };
}

function warnIfNonLoopback(host: string): void {
  if (host !== '127.0.0.1' && host !== 'localhost' && host !== '::1') {
    void vscode.window.showWarningMessage(
      `VSCode Internals is bound to ${host} — non-loopback addresses expose your editor to the network. ` +
      `Anyone reaching this port and obtaining the token can drive your VSCode.`,
    );
  }
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

function registerCommands(context: vscode.ExtensionContext): void {
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

  // Dev-only: soft-restart the HTTP server in place. Not registered in production
  // because it's primarily a test-harness affordance (lets the E2E runner cycle
  // the server without reloading the entire VSCode window). End users should use
  // the standard "Reload Window" command after changing port/host settings.
  if (context.extensionMode === vscode.ExtensionMode.Development) {
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
            },
          );
          try {
            await server.start();
            warnIfNonLoopback(config.host);
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
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration('vscodeInternals')) return;
      const cfg = readConfig();
      logger?.setLevel(cfg.logLevel);
      // port/host/body-size changes need a restart — prompt the user.
      if (
        e.affectsConfiguration('vscodeInternals.port') ||
        e.affectsConfiguration('vscodeInternals.host') ||
        e.affectsConfiguration('vscodeInternals.maxBodySizeBytes')
      ) {
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
 * Dev-only: write {url, token} JSON to `<tmpdir>/niradler.vscode-internals.dev.json`
 * so a local E2E script can talk to a freshly-launched Extension Development Host
 * without prompting the user. Never called in production.
 */
function writeDevHandshakeFile(token: string, config: RuntimeConfig, log: Logger): void {
  try {
    const file = path.join(os.tmpdir(), 'niradler.vscode-internals.dev.json');
    const payload = {
      url: `http://${config.host}:${config.port}`,
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
