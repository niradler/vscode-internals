import * as vscode from 'vscode';
import type { EndpointRegistry } from '../registry';

export function registerDebugRoutes(registry: EndpointRegistry, owner: string): void {
  const reg = (def: Parameters<EndpointRegistry['register']>[0]) =>
    registry.register({ tag: 'debug', ...def }, owner);

  reg({
    method: 'GET',
    path: '/debug/activeSession',
    summary: 'Currently active debug session',
    handler: () => {
      const s = vscode.debug.activeDebugSession;
      return s ? { id: s.id, name: s.name, type: s.type, configuration: s.configuration } : null;
    },
  });

  reg({
    method: 'POST',
    path: '/debug/start',
    summary: 'Start debugging using a named launch configuration (or inline config)',
    params: {
      type: 'object',
      properties: {
        workspaceFolderUri: { type: 'string', description: 'Workspace folder URI; omit to use the first folder' },
        nameOrConfig: { description: 'Either the launch config name (string) or an inline DebugConfiguration object' },
        parentSessionId: { type: 'string' },
        noDebug: { type: 'boolean' },
      },
      required: ['nameOrConfig'],
    },
    handler: async (raw, ctx) => {
      const p = raw as { workspaceFolderUri?: string; nameOrConfig: unknown; parentSessionId?: string; noDebug?: boolean };
      const folder = p.workspaceFolderUri
        ? vscode.workspace.getWorkspaceFolder(ctx.serializer.toUri(p.workspaceFolderUri))
        : vscode.workspace.workspaceFolders?.[0];
      const parent = p.parentSessionId
        ? findSessionById(p.parentSessionId)
        : undefined;
      const started = await vscode.debug.startDebugging(
        folder,
        p.nameOrConfig as string | vscode.DebugConfiguration,
        { parentSession: parent, noDebug: p.noDebug },
      );
      return { started, activeSessionId: vscode.debug.activeDebugSession?.id ?? null };
    },
  });

  reg({
    method: 'POST',
    path: '/debug/stop',
    summary: 'Stop a debug session (active session if no id)',
    params: { type: 'object', properties: { sessionId: { type: 'string' } } },
    handler: async (raw) => {
      const p = raw as { sessionId?: string };
      const session = p.sessionId ? findSessionById(p.sessionId) : vscode.debug.activeDebugSession;
      await vscode.debug.stopDebugging(session);
      return { ok: true };
    },
  });

  reg({
    method: 'GET',
    path: '/debug/breakpoints',
    summary: 'List breakpoints',
    handler: () => vscode.debug.breakpoints.map((bp) => describeBreakpoint(bp)),
  });

  reg({
    method: 'POST',
    path: '/debug/addBreakpoint',
    summary: 'Add a source breakpoint',
    params: {
      type: 'object',
      properties: {
        uri: { type: 'string' },
        line: { type: 'integer' },
        column: { type: 'integer' },
        condition: { type: 'string' },
        hitCondition: { type: 'string' },
        logMessage: { type: 'string' },
        enabled: { type: 'boolean' },
      },
      required: ['uri', 'line'],
    },
    handler: (raw, ctx) => {
      const p = raw as {
        uri: string; line: number; column?: number;
        condition?: string; hitCondition?: string; logMessage?: string; enabled?: boolean;
      };
      const loc = new vscode.Location(
        ctx.serializer.toUri(p.uri),
        new vscode.Position(p.line, p.column ?? 0),
      );
      const bp = new vscode.SourceBreakpoint(
        loc,
        p.enabled !== false,
        p.condition,
        p.hitCondition,
        p.logMessage,
      );
      vscode.debug.addBreakpoints([bp]);
      return { id: bp.id };
    },
  });

  reg({
    method: 'POST',
    path: '/debug/removeBreakpoints',
    summary: 'Remove breakpoints by ID',
    params: { type: 'object', properties: { ids: { type: 'array', items: { type: 'string' } } }, required: ['ids'] },
    handler: (raw) => {
      const p = raw as { ids: string[] };
      const targets = vscode.debug.breakpoints.filter((bp) => p.ids.includes(bp.id));
      vscode.debug.removeBreakpoints(targets);
      return { removed: targets.length };
    },
  });

  reg({
    method: 'POST',
    path: '/debug/customRequest',
    summary: 'Send a DAP custom request to a debug session (e.g. stackTrace, variables)',
    description: 'Useful for stepping, variable introspection, etc. Returns the raw DAP response.',
    params: {
      type: 'object',
      properties: {
        sessionId: { type: 'string' },
        command: { type: 'string', description: 'DAP request name, e.g. stackTrace, variables, scopes, continue, next, stepIn, stepOut' },
        args: { type: 'object' },
      },
      required: ['command'],
    },
    handler: async (raw) => {
      const p = raw as { sessionId?: string; command: string; args?: object };
      const session = p.sessionId ? findSessionById(p.sessionId) : vscode.debug.activeDebugSession;
      if (!session) throw new Error('No active debug session');
      const result = await session.customRequest(p.command, p.args ?? {});
      return { result };
    },
  });
}

function findSessionById(id: string): vscode.DebugSession | undefined {
  // VSCode does not expose a session registry; we track via the active session + custom requests.
  // For non-active sessions, this is best-effort and may return undefined.
  if (vscode.debug.activeDebugSession?.id === id) return vscode.debug.activeDebugSession;
  return undefined;
}

function describeBreakpoint(bp: vscode.Breakpoint): unknown {
  const base = {
    id: bp.id,
    enabled: bp.enabled,
    condition: bp.condition,
    hitCondition: bp.hitCondition,
    logMessage: bp.logMessage,
  };
  if (bp instanceof vscode.SourceBreakpoint) {
    return {
      ...base,
      kind: 'source',
      uri: bp.location.uri.toString(),
      line: bp.location.range.start.line,
      character: bp.location.range.start.character,
    };
  }
  if (bp instanceof vscode.FunctionBreakpoint) {
    return { ...base, kind: 'function', functionName: bp.functionName };
  }
  return { ...base, kind: 'other' };
}
