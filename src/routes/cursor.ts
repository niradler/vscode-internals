import * as vscode from 'vscode';
import type { EndpointRegistry } from '../registry';

export function registerCursorRoutes(registry: EndpointRegistry, owner: string): void {
  if (!detectCursor()) return;

  const reg = (def: Parameters<EndpointRegistry['register']>[0]) =>
    registry.register({ tag: 'cursor', ...def }, owner);

  reg({
    method: 'GET',
    path: '/cursor/agents',
    summary: 'List Cursor agents/composers with status, model, and (optionally) full state',
    description: [
      'Reads the live composer registry from Cursor\'s extension-host internals',
      '(`composer.getComposerHandleById().manager.loadedComposers.byId`). Returns a',
      'summary by default — pass `?include=conversation,todos,capabilities,context` to',
      'add bulky fields per agent. Filter to one agent with `?id=<uuid>`.',
      '',
      'Each agent record carries: composerId, createdAt, status (e.g. "none", "generating"),',
      'unifiedMode ("agent"/"ask"/"plan"/...), forceMode, agentBackend, modelConfig (model',
      'selection + parameters), messageCount, todoCount, subAgentCount, diff stats',
      '(totalLinesAdded/Removed, addedFiles/removedFiles), hasUnreadMessages, applied,',
      'and the current input-box text.',
      '',
      'CAVEAT: relies on private vscode-internal shape. Likely to change across Cursor',
      'releases. If callers see {error:"shape_changed"}, that\'s the signal.',
    ].join(' '),
    params: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Filter to a single composer UUID.' },
        include: { type: 'string', description: 'Comma-separated extra fields: conversation, todos, capabilities, context.' },
      },
    },
    handler: async (raw) => {
      const p = raw as { id?: string; include?: string };
      const includes = new Set((p.include ?? '').split(',').map((s) => s.trim()).filter(Boolean));
      const byId = await loadComposerRegistry();
      if (!byId) return { error: 'shape_changed', detail: 'Could not reach composer.loadedComposers.byId — Cursor internals may have changed.' };

      const summarize = (c: unknown): unknown => {
        const x = c as Record<string, unknown>;
        const out: Record<string, unknown> = {
          id: x.composerId,
          createdAt: x.createdAt,
          status: x.status,
          unifiedMode: x.unifiedMode,
          forceMode: x.forceMode,
          agentBackend: x.agentBackend,
          modelConfig: x.modelConfig,
          messageCount: arrayLength(x.fullConversationHeadersOnly),
          todoCount: arrayLength(x.todos),
          subAgentCount: arrayLength(x.subagentComposerIds) + arrayLength(x.subComposerIds),
          totalLinesAdded: x.totalLinesAdded,
          totalLinesRemoved: x.totalLinesRemoved,
          addedFiles: x.addedFiles,
          removedFiles: x.removedFiles,
          hasUnreadMessages: x.hasUnreadMessages,
          applied: x.applied,
          isAgentic: x.isAgentic,
          text: x.text,
          richText: x.richText,
        };
        if (includes.has('conversation')) {
          out.conversationHeaders = x.fullConversationHeadersOnly ?? [];
          out.conversationMap = sanitizeConversationMap(x.conversationMap);
        }
        if (includes.has('todos')) out.todos = x.todos;
        if (includes.has('capabilities')) out.capabilities = x.capabilities;
        if (includes.has('context')) out.context = x.context;
        return out;
      };

      if (p.id) {
        const c = byId[p.id];
        if (!c) return { error: 'not_found', id: p.id };
        return { agent: summarize(c) };
      }

      const selected = await safeExec<string[]>('composer.getOrderedSelectedComposerIds') ?? [];
      const agents = Object.keys(byId).map((id) => summarize(byId[id]));
      return { agents, selectedIds: selected, total: agents.length };
    },
  });

  reg({
    method: 'POST',
    path: '/cursor/chatEditing',
    summary: 'Accept or discard the agent\'s pending edits',
    description: 'Body: {action:"accept"|"discard", path?:string}. With no `path`, runs `chatEditing.acceptAllFiles` / `chatEditing.discardAllFiles`. With `path`, runs `chatEditing.acceptFile` / `chatEditing.discardFile` after wrapping the string as `vscode.Uri.file(path)` (load-bearing — `/commands/execute` passes JSON args verbatim, so a string path alone wouldn\'t work).',
    params: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['accept', 'discard'] },
        path: { type: 'string', description: 'Optional file path. Omit to act on all files in the active session.' },
      },
      required: ['action'],
    },
    handler: async (raw) => {
      const p = raw as { action: 'accept' | 'discard'; path?: string };
      const cmd = p.path
        ? (p.action === 'accept' ? 'chatEditing.acceptFile' : 'chatEditing.discardFile')
        : (p.action === 'accept' ? 'chatEditing.acceptAllFiles' : 'chatEditing.discardAllFiles');
      const args = p.path ? [vscode.Uri.file(p.path)] : [];
      try {
        const result = await vscode.commands.executeCommand(cmd, ...args);
        return { ok: true, result: result === undefined ? null : result };
      } catch (err) {
        return { ok: false, error: (err as Error).message };
      }
    },
  });
}

function detectCursor(): boolean {
  if (vscode.env.appName === 'Cursor') return true;
  if (vscode.env.uriScheme === 'cursor') return true;
  if ((vscode as unknown as { cursorVersion?: string }).cursorVersion) return true;
  return false;
}

async function loadComposerRegistry(): Promise<Record<string, unknown> | null> {
  // Any handle exposes the full byId registry via its manager — bootstrap from the selected id.
  const selected = await safeExec<string[]>('composer.getOrderedSelectedComposerIds');
  const seedId = selected?.[0];
  if (!seedId) return {};
  try {
    const h = await vscode.commands.executeCommand<unknown>('composer.getComposerHandleById', seedId);
    const handle = h as { manager?: { loadedComposers?: { byId?: Record<string, unknown> } } };
    return handle?.manager?.loadedComposers?.byId ?? null;
  } catch {
    return null;
  }
}

async function safeExec<T>(cmd: string, ...args: unknown[]): Promise<T | undefined> {
  try {
    return (await vscode.commands.executeCommand(cmd, ...args)) as T;
  } catch {
    return undefined;
  }
}

function arrayLength(v: unknown): number {
  return Array.isArray(v) ? v.length : 0;
}

function sanitizeConversationMap(v: unknown): unknown {
  // Field-pick avoids the 24MB+ explosion seen when serializing the full webview-bound bubble shape.
  if (!v || typeof v !== 'object') return v;
  const out: Record<string, unknown> = {};
  for (const [k, msg] of Object.entries(v as Record<string, unknown>)) {
    if (!msg || typeof msg !== 'object') { out[k] = msg; continue; }
    const m = msg as Record<string, unknown>;
    out[k] = {
      bubbleId: m.bubbleId,
      type: m.type,
      role: m.role,
      text: typeof m.text === 'string' ? m.text : undefined,
      richText: typeof m.richText === 'string' ? m.richText.slice(0, 4000) : undefined,
      createdAt: m.createdAt,
      tokenCount: m.tokenCount,
      modelName: m.modelName,
      finishReason: m.finishReason,
    };
  }
  return out;
}
