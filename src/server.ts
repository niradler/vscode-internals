import express, { type Express, type Request, type Response, type NextFunction } from 'express';
import * as http from 'http';
import * as path from 'path';
import * as vscode from 'vscode';
import { authMiddleware, type TokenManager } from './auth';
import { EventBus, writeSseEvent, writeSseHeaders } from './events';
import type { Logger } from './logger';
import { buildOpenAPI, swaggerUiHtml } from './openapi';
import type { EndpointContext, EndpointRegistry, RegisteredEndpoint } from './registry';
import type { Serializer } from './serializer';

export interface ServerConfig {
  port: number;
  host: string;
  maxBodySizeBytes: number;
  version: string;
  portAutoIncrement?: boolean;
  portAutoIncrementMax?: number;
}

export interface ServerDeps {
  registry: EndpointRegistry;
  serializer: Serializer;
  tokens: TokenManager;
  events: EventBus;
  logger: Logger;
}

export class InternalsServer {
  private app: Express;
  private server?: http.Server;
  private config: ServerConfig;
  private deps: ServerDeps;
  private mountedKey: Set<string> = new Set();
  private rebuildScheduled = false;
  /** Port the server is actually bound to — may differ from config.port if auto-incremented. */
  private boundPort?: number;

  constructor(deps: ServerDeps, config: ServerConfig) {
    this.deps = deps;
    this.config = config;
    this.app = express();
    this.setupApp();
    this.deps.registry.onChange(() => this.scheduleRebuild());
  }

  private setupApp(): void {
    const { logger, registry, serializer, tokens, events } = this.deps;

    this.app.disable('x-powered-by');
    this.app.use(express.json({ limit: this.config.maxBodySizeBytes }));
    this.app.use(express.urlencoded({ extended: false, limit: this.config.maxBodySizeBytes }));

    // Access log
    this.app.use((req, _res, next) => {
      logger.debug(`${req.method} ${req.path}`);
      next();
    });

    // Public endpoints (no auth)
    this.app.get('/health', (_req, res) => {
      res.json({ ok: true, version: this.config.version });
    });

    this.app.get('/openapi.json', (req, res) => {
      const baseUrl = `${req.protocol}://${req.get('host')}`;
      res.json(buildOpenAPI(registry, { baseUrl, version: this.config.version }));
    });

    // Serve Swagger UI assets from the bundled swagger-ui-dist package.
    // require.resolve gives us the path to a known file; dirname gives the asset dir.
    let swaggerAssetsDir: string | undefined;
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      swaggerAssetsDir = path.dirname(require.resolve('swagger-ui-dist/package.json'));
    } catch (err) {
      logger.warn('swagger-ui-dist not resolvable; /docs will not render', err);
    }
    if (swaggerAssetsDir) {
      this.app.use('/docs/assets', express.static(swaggerAssetsDir, { index: false }));
    }
    this.app.get('/docs', (_req, res) => {
      res.type('html').send(swaggerUiHtml('/openapi.json', '/docs/assets'));
    });

    // Auth gate for everything below.
    this.app.use(authMiddleware(() => tokens.getOrCreate()));

    // SSE: GET /events?subscribe=name1,name2
    this.app.get('/events', (req, res) => {
      const subscribeParam = String(req.query.subscribe ?? '').trim();
      const names = subscribeParam ? subscribeParam.split(',').map((s) => s.trim()).filter(Boolean) : [];
      if (names.length === 0) {
        res.status(400).json({
          error: 'no_subscriptions',
          message: 'Provide ?subscribe=event1,event2',
          available: events.listAvailable(),
        });
        return;
      }
      let unsubscribe: (() => void) | undefined;
      try {
        unsubscribe = events.subscribe(names, (eventName, payload) => {
          writeSseEvent(res, eventName, payload);
        });
      } catch (err) {
        res.status(400).json({ error: 'subscribe_failed', message: (err as Error).message });
        return;
      }
      writeSseHeaders(res);
      writeSseEvent(res, 'ready', { subscribed: names });

      const heartbeat = setInterval(() => res.write(': ping\n\n'), 25_000);
      const cleanup = () => {
        clearInterval(heartbeat);
        unsubscribe?.();
      };
      req.on('close', cleanup);
      req.on('error', cleanup);
    });

    // GET /events/available — what event names can be subscribed.
    this.app.get('/events/available', (_req, res) => {
      res.json({ events: events.listAvailable() });
    });

    // Long-poll: GET /events/wait?subscribe=…&filter=<json>&match=first|all&timeoutMs=…
    this.app.get('/events/wait', (req, res) => {
      const subscribeParam = String(req.query.subscribe ?? '').trim();
      const names = subscribeParam ? subscribeParam.split(',').map((s) => s.trim()).filter(Boolean) : [];
      if (names.length === 0) {
        res.status(400).json({
          error: 'no_subscriptions',
          message: 'Provide ?subscribe=event1,event2',
          available: events.listAvailable(),
        });
        return;
      }

      let filter: Record<string, unknown> | undefined;
      if (req.query.filter !== undefined) {
        try {
          const parsed = JSON.parse(String(req.query.filter));
          if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
            throw new Error('filter must be a JSON object');
          }
          filter = parsed as Record<string, unknown>;
        } catch (err) {
          res.status(400).json({ error: 'bad_filter', message: (err as Error).message });
          return;
        }
      }

      const match = String(req.query.match ?? 'first');
      if (match !== 'first' && match !== 'all') {
        res.status(400).json({ error: 'bad_match', message: 'match must be "first" or "all"' });
        return;
      }

      const timeoutMs = Math.min(Math.max(Number(req.query.timeoutMs ?? 30_000), 1_000), 300_000);
      const started = Date.now();

      const matches = (payload: unknown): boolean => {
        if (!filter) return true;
        if (payload === null || typeof payload !== 'object') return false;
        const obj = payload as Record<string, unknown>;
        for (const [k, v] of Object.entries(filter)) {
          if (obj[k] !== v) return false;
        }
        return true;
      };

      let unsubscribe: (() => void) | undefined;
      let timer: NodeJS.Timeout | undefined;
      let settled = false;

      const cleanup = () => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        unsubscribe?.();
      };

      if (match === 'first') {
        try {
          unsubscribe = events.subscribe(names, (eventName, payload) => {
            if (settled) return;
            if (!matches(payload)) return;
            cleanup();
            res.json({ eventName, payload, waitedMs: Date.now() - started });
          });
        } catch (err) {
          res.status(400).json({ error: 'subscribe_failed', message: (err as Error).message });
          return;
        }
        timer = setTimeout(() => {
          if (settled) return;
          cleanup();
          res.json({ timeout: true, waitedMs: Date.now() - started });
        }, timeoutMs);
        req.on('close', cleanup);
        req.on('error', cleanup);
        return;
      }

      try {
        unsubscribe = events.subscribe(names, (eventName, payload) => {
          if (settled) return;
          if (!matches(payload)) return;
          writeSseEvent(res, eventName, payload);
        });
      } catch (err) {
        res.status(400).json({ error: 'subscribe_failed', message: (err as Error).message });
        return;
      }
      writeSseHeaders(res);
      writeSseEvent(res, 'ready', { subscribed: names, filter: filter ?? null, timeoutMs });
      const heartbeat = setInterval(() => res.write(': ping\n\n'), 25_000);
      const closeStream = () => {
        if (settled) return;
        settled = true;
        clearInterval(heartbeat);
        unsubscribe?.();
        try { res.end(); } catch { void 0; }
      };
      timer = setTimeout(closeStream, timeoutMs);
      req.on('close', () => { clearInterval(heartbeat); cleanup(); });
      req.on('error', () => { clearInterval(heartbeat); cleanup(); });
    });

    // Dynamic endpoint dispatcher — every registered endpoint flows through here.
    // We attach a single express middleware that does the dispatch so we don't have
    // to re-bind express routes when endpoints are added/removed at runtime.
    this.app.use((req, res, next) => {
      const method = req.method.toUpperCase() as RegisteredEndpoint['method'];
      const ep = registry.find(method, req.path);
      if (!ep) return next();
      const params = method === 'GET' || method === 'DELETE' ? req.query : req.body;
      const ctx: EndpointContext = { vscode, logger, serializer, req };
      Promise.resolve()
        .then(() => ep.handler(params, ctx))
        .then((result) => {
          if (res.headersSent) return; // handler chose to manage response itself
          res.json(result ?? null);
        })
        .catch((err: unknown) => {
          const e = err as Error;
          logger.warn(`Endpoint ${method} ${req.path} threw: ${e.message}`);
          if (res.headersSent) return;
          res.status(500).json({
            error: 'endpoint_error',
            message: e.message,
            endpoint: `${method} ${req.path}`,
          });
        });
    });

    // Fallback 404 for unmatched paths.
    this.app.use((req, res) => {
      res.status(404).json({
        error: 'not_found',
        message: `No endpoint for ${req.method} ${req.path}. See /openapi.json for available endpoints.`,
      });
    });

    // Express error handler — final safety net for synchronous throws / bad JSON.
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    this.app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
      logger.error('Unhandled express error', err);
      if (res.headersSent) return;
      res.status(500).json({ error: 'server_error', message: err.message });
    });
  }

  private scheduleRebuild(): void {
    // Endpoint changes are dispatched through the registry lookup directly, so we
    // don't actually need to rebind express routes. This hook is reserved for future
    // optimizations (e.g. caching the OpenAPI doc).
    if (this.rebuildScheduled) return;
    this.rebuildScheduled = true;
    setImmediate(() => {
      this.rebuildScheduled = false;
      this.mountedKey.clear();
    });
  }

  async start(): Promise<void> {
    if (this.server) return;
    const basePort = this.config.port;
    const bumpEnabled = this.config.portAutoIncrement !== false;
    const maxBump = bumpEnabled ? Math.max(0, this.config.portAutoIncrementMax ?? 20) : 0;
    let lastErr: NodeJS.ErrnoException | undefined;
    for (let offset = 0; offset <= maxBump; offset++) {
      const candidate = basePort + offset;
      try {
        await this.tryListen(candidate);
        this.boundPort = candidate;
        if (offset > 0) {
          this.deps.logger.warn(
            `Port ${basePort} was in use; server bound to ${candidate} instead (bump=${offset}).`,
          );
        } else {
          this.deps.logger.info(`Listening on http://${this.config.host}:${candidate}`);
        }
        return;
      } catch (err) {
        const e = err as NodeJS.ErrnoException;
        lastErr = e;
        if (e.code !== 'EADDRINUSE') throw e;
        this.deps.logger.debug(`Port ${candidate} in use, trying next`);
      }
    }
    const tried = maxBump > 0
      ? `ports ${basePort}–${basePort + maxBump}`
      : `port ${basePort}`;
    const hint = bumpEnabled
      ? ` Increase vscodeInternals.portAutoIncrementMax or pick a free starting port.`
      : ` Enable vscodeInternals.portAutoIncrement to bump automatically.`;
    const err = new Error(`EADDRINUSE: ${tried} all in use.${hint}`) as NodeJS.ErrnoException;
    err.code = 'EADDRINUSE';
    err.cause = lastErr;
    throw err;
  }

  /** Try to bind a single port; resolves on success, rejects with the listen error. */
  private tryListen(port: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const server = http.createServer(this.app);
      const onError = (err: NodeJS.ErrnoException) => {
        server.removeListener('listening', onListening);
        // Hand the failed server to libuv for cleanup but don't await it — close()
        // on a server that never reached 'listening' can leave the handle in a state
        // where awaiting the callback races with libuv shutdown and asserts on Windows.
        // The fire-and-forget close lets libuv tear down on its own schedule.
        try { server.close(() => { /* swallow */ }); } catch { /* ignore */ }
        reject(err);
      };
      const onListening = () => {
        server.removeListener('error', onError);
        // Re-attach a long-lived error listener for runtime errors after a successful bind.
        server.on('error', (err) => this.deps.logger.error('HTTP server error', err));
        this.server = server;
        resolve();
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(port, this.config.host);
    });
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    await new Promise<void>((resolve) => {
      this.server!.close(() => resolve());
    });
    this.server = undefined;
    this.boundPort = undefined;
  }

  /** Port the server is actually bound to (may differ from the configured port). */
  get port(): number {
    return this.boundPort ?? this.config.port;
  }

  get url(): string {
    return `http://${this.config.host}:${this.port}`;
  }
}
