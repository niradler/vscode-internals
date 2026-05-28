import * as vscode from 'vscode';
import type { EndpointRegistry } from '../registry';

export function registerExtensionsRoutes(registry: EndpointRegistry, owner: string): void {
  const reg = (def: Parameters<EndpointRegistry['register']>[0]) =>
    registry.register({ tag: 'extensions', ...def }, owner);

  reg({
    method: 'GET',
    path: '/extensions/list',
    summary: 'List installed extensions',
    params: {
      type: 'object',
      properties: {
        includeBuiltin: { type: 'boolean', description: 'Include extensions built into VSCode (default false)' },
      },
    },
    handler: (raw) => {
      const p = raw as { includeBuiltin?: boolean };
      return vscode.extensions.all
        .filter((e) => p.includeBuiltin || !e.packageJSON.isBuiltin)
        .map((e) => ({
          id: e.id,
          isActive: e.isActive,
          extensionKind: e.extensionKind,
          extensionPath: e.extensionUri.fsPath,
          packageJSON: {
            name: e.packageJSON.name,
            displayName: e.packageJSON.displayName,
            version: e.packageJSON.version,
            publisher: e.packageJSON.publisher,
            description: e.packageJSON.description,
            engines: e.packageJSON.engines,
            categories: e.packageJSON.categories,
            isBuiltin: e.packageJSON.isBuiltin === true,
          },
        }));
    },
  });

  reg({
    method: 'GET',
    path: '/extensions/get',
    summary: 'Details of a single extension by ID',
    params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    handler: (raw) => {
      const p = raw as { id: string };
      const e = vscode.extensions.getExtension(p.id);
      if (!e) return null;
      return {
        id: e.id,
        isActive: e.isActive,
        extensionKind: e.extensionKind,
        extensionPath: e.extensionUri.fsPath,
        packageJSON: e.packageJSON,
      };
    },
  });

  reg({
    method: 'POST',
    path: '/extensions/activate',
    summary: 'Activate an extension by ID',
    params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    handler: async (raw) => {
      const p = raw as { id: string };
      const e = vscode.extensions.getExtension(p.id);
      if (!e) throw new Error(`Extension not found: ${p.id}`);
      await e.activate();
      return { id: e.id, isActive: e.isActive };
    },
  });

  reg({
    method: 'GET',
    path: '/extensions/apis',
    summary: 'List extensions that export a programmatic API',
    description:
      'Returns every active extension whose `exports` is non-null. For each, lists the top-level keys ' +
      'and the apparent shape of each value (function vs object vs primitive). Use this to discover what ' +
      'is callable via /extensions/invoke. Extensions are activated lazily — pass activate=true to force ' +
      'activation of all extensions first (slower; may trigger UI side effects).',
    params: {
      type: 'object',
      properties: {
        activate: { type: 'boolean', description: 'Force-activate all extensions before listing (default false)' },
      },
    },
    handler: async (raw) => {
      const p = raw as { activate?: boolean };
      if (p.activate) {
        await Promise.allSettled(vscode.extensions.all.map((e) => (e.isActive ? null : e.activate())));
      }
      return vscode.extensions.all
        .filter((e) => e.isActive && e.exports != null)
        .map((e) => describeExports(e.id, e.exports));
    },
  });

  reg({
    method: 'POST',
    path: '/extensions/invoke',
    summary: "Call a method on another extension's exported API",
    description:
      'Activates the extension if needed, then walks `path` (dot-separated) on its `exports`. If the ' +
      'resolved value is a function, calls it with `args` (with the parent object as `this`) and awaits ' +
      'the result. Non-serializable values (Disposables, EventEmitters, vscode Uri/Range/etc.) are ' +
      'coerced to a best-effort JSON shape via the serializer; opaque objects become ' +
      '{ __type: "ClassName", __keys: [...] }.',
    params: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Extension id, e.g. "ms-python.python"' },
        path: { type: 'string', description: 'Dot-separated path on exports, e.g. "getApi" or "settings.get"' },
        args: { type: 'array', description: 'Positional arguments if path resolves to a function' },
      },
      required: ['id', 'path'],
    },
    handler: async (raw, ctx) => {
      const p = raw as { id: string; path: string; args?: unknown[] };
      const ext = vscode.extensions.getExtension(p.id);
      if (!ext) throw new Error(`Extension not found: ${p.id}`);
      if (!ext.isActive) await ext.activate();
      if (ext.exports == null) {
        return { kind: 'no-exports', id: ext.id };
      }

      const segments = p.path.split('.').filter(Boolean);
      let cursor: unknown = ext.exports;
      let parent: unknown = undefined;
      const traversed: string[] = [];
      for (const seg of segments) {
        if (cursor == null) {
          throw new Error(
            `Path traversal failed: "${traversed.join('.')}" is ${cursor === null ? 'null' : 'undefined'}, ` +
              `cannot read "${seg}"`,
          );
        }
        parent = cursor;
        cursor = (cursor as Record<string, unknown>)[seg];
        traversed.push(seg);
      }

      if (typeof cursor === 'function') {
        const fn = cursor as (...a: unknown[]) => unknown;
        const result = await Promise.resolve(fn.apply(parent, p.args ?? []));
        return { kind: 'invoked', path: p.path, result: safeSerialize(result, ctx.serializer) };
      }
      return { kind: 'value', path: p.path, value: safeSerialize(cursor, ctx.serializer) };
    },
  });
}

function describeExports(id: string, exp: unknown): unknown {
  if (exp == null) return { id, exports: null };
  if (typeof exp !== 'object') {
    return { id, exportsType: typeof exp, exportsValue: safeSerialize(exp) };
  }
  const keys = Object.keys(exp as object);
  const shape: Record<string, string> = {};
  for (const k of keys) {
    const v = (exp as Record<string, unknown>)[k];
    shape[k] = typeof v === 'function' ? 'function' : v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v;
  }
  return { id, exportsType: 'object', keys, shape };
}

function safeSerialize(value: unknown, serializer?: import('../serializer').Serializer, seen = new WeakSet<object>()): unknown {
  if (value === null || value === undefined) return value;
  const t = typeof value;
  if (t === 'string' || t === 'number' || t === 'boolean') return value;
  if (t === 'function') return { __type: 'function' };
  if (t === 'bigint') return value.toString();
  if (t === 'symbol') return value.toString();

  if (value instanceof vscode.Uri) return serializer?.uri(value) ?? value.toString();
  if (value instanceof vscode.Position) return { line: value.line, character: value.character };
  if (value instanceof vscode.Range) {
    return {
      start: { line: value.start.line, character: value.start.character },
      end: { line: value.end.line, character: value.end.character },
    };
  }

  if (typeof value === 'object') {
    if (seen.has(value as object)) return { __type: 'circular' };
    seen.add(value as object);

    if (Array.isArray(value)) {
      return value.map((v) => safeSerialize(v, serializer, seen));
    }

    const ctorName = (value as object).constructor?.name;
    if (ctorName === 'Disposable') return { __type: 'Disposable' };
    if (ctorName === 'EventEmitter' || ctorName?.startsWith('Emitter')) return { __type: 'EventEmitter' };

    const out: Record<string, unknown> = {};
    const keys = Object.keys(value as object);
    let truncated = false;
    for (let i = 0; i < keys.length; i++) {
      if (i >= 50) {
        truncated = true;
        break;
      }
      const k = keys[i];
      try {
        out[k] = safeSerialize((value as Record<string, unknown>)[k], serializer, seen);
      } catch {
        out[k] = { __type: 'unserializable' };
      }
    }
    if (truncated) out.__truncated = `${keys.length - 50} more keys omitted`;
    if (ctorName && ctorName !== 'Object') out.__type = ctorName;
    return out;
  }

  return { __type: 'unknown' };
}
