import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import type { EndpointRegistry } from '../registry';
import type { EventBus } from '../events';
import type { Logger } from '../logger';

export interface DevDeps {
  events: EventBus;
  logger: Logger;
  registry: EndpointRegistry;
}

export function registerDevRoutes(registry: EndpointRegistry, owner: string, deps: DevDeps): void {
  const reg = (def: Parameters<EndpointRegistry['register']>[0]) =>
    registry.register({ tag: 'dev', ...def }, owner);

  reg({
    method: 'POST',
    path: '/dev/eval',
    summary: 'DEV-ONLY: evaluate arbitrary JS in the extension host context',
    description: 'Body: {code, args?, timeoutMs?}. Code runs as the body of an async function with these in scope: vscode, args, logger, registry, events, ctx, console, fs, os, path, require, process. Use `return <expr>` to return a value. Console output is captured and returned in `logs`. Result is JSON-serialized — Uri-like objects get a {__type:"Uri", toString, fsPath} shape; functions become "<function name>". Throws are returned as 4xx with message + stack.',
    params: {
      type: 'object',
      properties: {
        code: { type: 'string', description: 'JS body. Implicit async — use await freely.' },
        args: { description: 'Passed as `args` to the eval body.' },
        timeoutMs: { type: 'integer', description: 'Max wait in ms (100..60000). Default 10000.' },
      },
      required: ['code'],
    },
    handler: async (raw, ctx) => {
      const p = raw as { code: string; args?: unknown; timeoutMs?: number };
      const timeoutMs = Math.min(Math.max(p.timeoutMs ?? 10_000, 100), 60_000);

      const logs: Array<{ level: string; msg: string }> = [];
      const captureLog = (level: string) =>
        (...vals: unknown[]) => {
          logs.push({ level, msg: vals.map((v) => (typeof v === 'string' ? v : safeStringify(v))).join(' ') });
        };
      const consoleProxy = {
        log: captureLog('log'), info: captureLog('info'),
        warn: captureLog('warn'), error: captureLog('error'), debug: captureLog('debug'),
      };

      const AsyncFn = Object.getPrototypeOf(async function noop() { /* noop */ }).constructor as new (...a: string[]) => (...args: unknown[]) => Promise<unknown>;

      let fn: (...a: unknown[]) => Promise<unknown>;
      try {
        fn = new AsyncFn(
          'vscode', 'args', 'logger', 'registry', 'events', 'ctx', 'console',
          'fs', 'os', 'path', 'require', 'process',
          p.code,
        );
      } catch (err) {
        const e = err as Error;
        throw new Error(`Eval compile error: ${e.message}`);
      }

      const exec = fn(
        vscode, p.args, deps.logger, deps.registry, deps.events, ctx, consoleProxy,
        fs, os, path, require, process,
      );
      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`Eval timed out after ${timeoutMs}ms`)), timeoutMs);
      });

      try {
        const result = await Promise.race([exec, timeout]);
        return { result: safeSerialize(result), logs };
      } finally {
        if (timer) clearTimeout(timer);
      }
    },
  });

  reg({
    method: 'GET',
    path: '/dev/info',
    summary: 'DEV-ONLY: process + host info useful for exploration',
    handler: () => ({
      appName: vscode.env.appName,
      appHost: vscode.env.appHost,
      appRoot: vscode.env.appRoot,
      uriScheme: vscode.env.uriScheme,
      remoteName: vscode.env.remoteName,
      machineId: vscode.env.machineId,
      sessionId: vscode.env.sessionId,
      shell: vscode.env.shell,
      language: vscode.env.language,
      version: vscode.version,
      pid: process.pid,
      platform: process.platform,
      arch: process.arch,
      execPath: process.execPath,
      nodeVersion: process.versions.node,
      electronVersion: process.versions.electron ?? null,
      chromeVersion: process.versions.chrome ?? null,
    }),
  });
}

function safeSerialize(v: unknown): unknown {
  const seen = new WeakSet<object>();
  try {
    return JSON.parse(JSON.stringify(v, (_k, val) => {
      if (val === undefined) return null;
      if (typeof val === 'bigint') return `${val.toString()}n`;
      if (typeof val === 'function') {
        const name = (val as { name?: string }).name ?? 'anonymous';
        return `<function ${name}>`;
      }
      if (typeof val === 'symbol') return val.toString();
      if (val && typeof val === 'object') {
        if (seen.has(val)) return '<circular>';
        seen.add(val);
        const obj = val as { fsPath?: unknown; scheme?: unknown; toString?: () => string };
        if (typeof obj.fsPath === 'string' && typeof obj.scheme === 'string' && typeof obj.toString === 'function') {
          return { __type: 'Uri', toString: obj.toString(), fsPath: obj.fsPath };
        }
      }
      return val;
    }));
  } catch {
    return String(v);
  }
}

function safeStringify(v: unknown): string {
  try { return JSON.stringify(v); } catch { return String(v); }
}
