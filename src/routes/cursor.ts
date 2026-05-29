import * as vscode from 'vscode';
import type { EndpointRegistry } from '../registry';

/**
 * Cursor-specific routes. Kept deliberately minimal — anything reachable via
 * `/commands/execute` doesn't earn its own route, anything reachable via
 * `/workspace/readFile` or `/commands/list` doesn't either. The one endpoint here
 * is the only thing that does work the generic surface can't: the chatEditing
 * commands take a `vscode.Uri`, and `/commands/execute` passes JSON args verbatim
 * — there's no way for a caller to construct a Uri over HTTP.
 *
 * Safe on any host: handler returns `{supported:false}` on non-Cursor instead of
 * throwing, so a caller on VSCode hits this endpoint and gets a clean signal
 * rather than an exception. Recipes for MCP config / active server discovery /
 * agents API live in docs/cursor-capabilities.md.
 */
export function registerCursorRoutes(registry: EndpointRegistry, owner: string): void {
  const reg = (def: Parameters<EndpointRegistry['register']>[0]) =>
    registry.register({ tag: 'cursor', ...def }, owner);

  reg({
    method: 'POST',
    path: '/cursor/chatEditing',
    summary: 'Accept or discard the agent\'s pending edits',
    description: 'Body: {action:"accept"|"discard", path?:string}. With no `path`, runs `chatEditing.acceptAllFiles` / `chatEditing.discardAllFiles`. With `path`, runs `chatEditing.acceptFile` / `chatEditing.discardFile` after wrapping the string as `vscode.Uri.file(path)` (load-bearing — `/commands/execute` passes JSON args verbatim, so a string path alone wouldn\'t work). Returns `{supported:false}` on non-Cursor hosts.',
    params: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['accept', 'discard'] },
        path: { type: 'string', description: 'Optional file path to act on. Omit to apply to all files in the active chat editing session.' },
      },
      required: ['action'],
    },
    handler: (raw) => {
      const p = raw as { action: 'accept' | 'discard'; path?: string };
      const cmd = p.path
        ? (p.action === 'accept' ? 'chatEditing.acceptFile' : 'chatEditing.discardFile')
        : (p.action === 'accept' ? 'chatEditing.acceptAllFiles' : 'chatEditing.discardAllFiles');
      const args = p.path ? [vscode.Uri.file(p.path)] : [];
      return cursorCmd(cmd, args);
    },
  });
}

function detectCursor(): boolean {
  if (vscode.env.appName === 'Cursor') return true;
  if (vscode.env.uriScheme === 'cursor') return true;
  if ((vscode as unknown as { cursorVersion?: string }).cursorVersion) return true;
  return false;
}

async function cursorCmd(command: string, args: unknown[] = []): Promise<unknown> {
  if (!detectCursor()) return { supported: false, reason: 'Not running in Cursor' };
  try {
    const result = await vscode.commands.executeCommand(command, ...args);
    return { ok: true, result: result === undefined ? null : result };
  } catch (err) {
    const e = err as Error;
    return { ok: false, error: e.message };
  }
}
