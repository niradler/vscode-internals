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
    return new Promise((resolve, reject) => {
      this.server = http.createServer(this.app);
      this.server.on('error', (err) => {
        this.deps.logger.error('HTTP server error', err);
        reject(err);
      });
      this.server.listen(this.config.port, this.config.host, () => {
        this.deps.logger.info(`Listening on http://${this.config.host}:${this.config.port}`);
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    await new Promise<void>((resolve) => {
      this.server!.close(() => resolve());
    });
    this.server = undefined;
  }

  get url(): string {
    return `http://${this.config.host}:${this.config.port}`;
  }
}
