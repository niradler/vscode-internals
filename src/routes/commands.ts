import * as vscode from 'vscode';
import type { EndpointRegistry } from '../registry';

export function registerCommandsRoutes(registry: EndpointRegistry, owner: string): void {
  const reg = (def: Parameters<EndpointRegistry['register']>[0]) =>
    registry.register({ tag: 'commands', ...def }, owner);

  reg({
    method: 'GET',
    path: '/commands/list',
    summary: 'List registered commands',
    params: {
      type: 'object',
      properties: {
        filterInternal: { type: 'boolean', description: 'Hide commands prefixed with _' },
        filter: { type: 'string', description: 'Substring filter applied to command IDs' },
      },
    },
    handler: async (raw) => {
      const p = raw as { filterInternal?: boolean; filter?: string };
      const all = await vscode.commands.getCommands(p.filterInternal ?? true);
      const filtered = p.filter ? all.filter((c) => c.toLowerCase().includes(p.filter!.toLowerCase())) : all;
      return { count: filtered.length, commands: filtered.sort() };
    },
  });

  reg({
    method: 'POST',
    path: '/commands/execute',
    summary: 'Execute a VSCode command (the full command palette is reachable through here)',
    params: {
      type: 'object',
      properties: {
        command: { type: 'string' },
        args: { type: 'array', description: 'Positional arguments to the command' },
      },
      required: ['command'],
    },
    handler: async (raw) => {
      const p = raw as { command: string; args?: unknown[] };
      const result = await vscode.commands.executeCommand(p.command, ...(p.args ?? []));
      return { result: serializeCommandResult(result) };
    },
  });
}

/**
 * Best-effort serialization of arbitrary command results. Commands can return anything;
 * we attempt to make the response JSON-safe without losing too much information.
 */
function serializeCommandResult(value: unknown): unknown {
  if (value === undefined || value === null) return null;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.map(serializeCommandResult);
  try {
    JSON.stringify(value);
    return value;
  } catch {
    return { _unserializable: true, _type: typeof value, _string: String(value) };
  }
}
