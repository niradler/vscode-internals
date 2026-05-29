import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import type { EndpointRegistry } from '../registry';

/**
 * Cursor-specific routes. Kept deliberately small — anything that's a pure passthrough
 * to a Cursor command (e.g. `glass.newAgentWithQuery`, `glass.openAgentById`,
 * `composer.getOrderedSelectedComposerIds`) is reachable via `/commands/execute` and
 * doesn't earn its own route. The endpoints below each do something `/commands/execute`
 * alone can't: host detection synthesis, filesystem reads with secret redaction,
 * command-name scraping for a missing API, or input-shape branching.
 *
 * Cursor's `vscode.cursor.*` private namespace is gated to built-in extensions; for
 * everything else, drive Cursor through `/commands/execute` with `glass.*` /
 * `composer.*` / `chatEditing.*` commands. See docs/cursor-capabilities.md.
 */
export function registerCursorRoutes(registry: EndpointRegistry, owner: string): void {
  const reg = (def: Parameters<EndpointRegistry['register']>[0]) =>
    registry.register({ tag: 'cursor', ...def }, owner);

  reg({
    method: 'GET',
    path: '/cursor/mcp/configured',
    summary: 'List MCP servers configured in ~/.cursor/mcp.json and <ws>/.cursor/mcp.json',
    description: 'Reads both files from disk. Bearer tokens and other secret-ish fields (Authorization, apiKey, accessToken, token, password, bearer) are redacted to "<redacted>" by default — pass `?revealSecrets=true` for raw values. Returns `{ user: {path, exists, servers}|null, workspace: {path, exists, servers}|null }`. No public Cursor API exposes this for third-party extensions.',
    params: {
      type: 'object',
      properties: { revealSecrets: { type: 'boolean' } },
    },
    handler: (raw) => {
      const p = raw as { revealSecrets?: boolean | string };
      const reveal = p.revealSecrets === true || p.revealSecrets === 'true';
      const userPath = path.join(os.homedir(), '.cursor', 'mcp.json');
      const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      const wsPath = wsRoot ? path.join(wsRoot, '.cursor', 'mcp.json') : null;
      return {
        user: readMcpConfig(userPath, reveal),
        workspace: wsPath ? readMcpConfig(wsPath, reveal) : null,
      };
    },
  });

  reg({
    method: 'GET',
    path: '/cursor/mcp/active',
    summary: 'List MCP server IDs that Cursor has currently activated',
    description: 'Scrapes the command palette for `workbench.action.output.show.anysphere.cursor-mcp.MCP <serverId>.workspaceId-…` entries. Not an official API — Cursor surfaces no public listing for non-built-in extensions. Falls back to empty array on non-Cursor hosts.',
    handler: async () => {
      const all = await vscode.commands.getCommands(true);
      const prefix = 'workbench.action.output.show.anysphere.cursor-mcp.MCP ';
      const servers = new Set<string>();
      for (const c of all) {
        if (!c.startsWith(prefix)) continue;
        const rest = c.slice(prefix.length);
        const wsIdx = rest.lastIndexOf('.workspaceId-');
        const id = wsIdx > 0 ? rest.slice(0, wsIdx) : rest;
        servers.add(id);
      }
      return { servers: [...servers].sort() };
    },
  });

  reg({
    method: 'POST',
    path: '/cursor/chatEditing/accept',
    summary: 'Accept the agent\'s pending edits — all files or one',
    description: 'With no `path`, runs `chatEditing.acceptAllFiles`. With `path`, runs `chatEditing.acceptFile` for the given file (string wrapped as `vscode.Uri.file`). Cursor decides which session to apply to (the active chat editing session). Returns `{supported:false}` if not Cursor.',
    params: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Optional file path to accept. Omit to accept all.' } },
    },
    handler: (raw) => {
      const p = raw as { path?: string };
      if (p.path) return cursorCmd('chatEditing.acceptFile', [vscode.Uri.file(p.path)]);
      return cursorCmd('chatEditing.acceptAllFiles');
    },
  });

  reg({
    method: 'POST',
    path: '/cursor/chatEditing/discard',
    summary: 'Discard the agent\'s pending edits — all files or one',
    description: 'With no `path`, runs `chatEditing.discardAllFiles`. With `path`, runs `chatEditing.discardFile`. Returns `{supported:false}` if not Cursor.',
    params: {
      type: 'object',
      properties: { path: { type: 'string' } },
    },
    handler: (raw) => {
      const p = raw as { path?: string };
      if (p.path) return cursorCmd('chatEditing.discardFile', [vscode.Uri.file(p.path)]);
      return cursorCmd('chatEditing.discardAllFiles');
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

interface ParsedMcpConfig {
  path: string;
  exists: boolean;
  servers?: Record<string, unknown>;
  error?: string;
}

function readMcpConfig(p: string, reveal: boolean): ParsedMcpConfig {
  if (!fs.existsSync(p)) return { path: p, exists: false };
  try {
    const txt = fs.readFileSync(p, 'utf8');
    const json = JSON.parse(txt) as { mcpServers?: Record<string, unknown> };
    const servers = json.mcpServers ?? {};
    return {
      path: p,
      exists: true,
      servers: reveal ? servers : (redactSecrets(servers) as Record<string, unknown>),
    };
  } catch (err) {
    const e = err as Error;
    return { path: p, exists: true, error: `parse failed: ${e.message}` };
  }
}

const SECRET_KEY_RE = /^(authorization|api[-_]?key|apikey|access[-_]?token|secret|password|bearer|token)$/i;

function redactSecrets(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(redactSecrets);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (SECRET_KEY_RE.test(k)) {
      out[k] = typeof v === 'string' ? '<redacted>' : '<redacted-object>';
    } else if (typeof v === 'string' && /^(Bearer |gho_|ghp_|sk-|xoxb-|xoxp-)/.test(v)) {
      out[k] = '<redacted>';
    } else {
      out[k] = redactSecrets(v);
    }
  }
  return out;
}
