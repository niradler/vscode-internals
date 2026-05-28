import * as vscode from 'vscode';
import type { EndpointRegistry } from '../registry';

/**
 * Tab and tab-group management.
 *
 * vscode.window.tabGroups is the source of truth for what's open in the editor area —
 * tabs are richer than text editors (they include diff editors, custom editors, terminals,
 * webviews, notebooks, etc.). Routes here let callers list, close, pin, and move tabs
 * without going through commands.
 */
export function registerTabsRoutes(registry: EndpointRegistry, owner: string): void {
  const reg = (def: Parameters<EndpointRegistry['register']>[0]) =>
    registry.register({ tag: 'tabs', ...def }, owner);

  reg({
    method: 'GET',
    path: '/tabs/groups',
    summary: 'List all tab groups (editor columns) with their tabs',
    handler: (_, ctx) => ({
      activeGroupViewColumn: vscode.window.tabGroups.activeTabGroup.viewColumn,
      groups: vscode.window.tabGroups.all.map((g) => describeGroup(g, ctx.serializer)),
    }),
  });

  reg({
    method: 'GET',
    path: '/tabs/list',
    summary: 'Flat list of all open tabs across all groups',
    handler: (_, ctx) => {
      const out: unknown[] = [];
      for (const g of vscode.window.tabGroups.all) {
        for (const t of g.tabs) {
          out.push({ ...(describeTab(t, ctx.serializer) as object), groupViewColumn: g.viewColumn });
        }
      }
      return out;
    },
  });

  reg({
    method: 'GET',
    path: '/tabs/active',
    summary: 'The active tab in the active group',
    handler: (_, ctx) => {
      const t = vscode.window.tabGroups.activeTabGroup.activeTab;
      return t ? describeTab(t, ctx.serializer) : null;
    },
  });

  reg({
    method: 'POST',
    path: '/tabs/close',
    summary: 'Close tab(s) matching a URI, label, or position',
    description:
      'Closes tabs identified by either: (a) `uri` — closes all tabs whose input has matching URI; ' +
      '(b) `label` — closes tabs by exact label match; (c) `viewColumn` + `index` — closes the tab at ' +
      'that position. At least one matcher is required. Pass preserveFocus=true to avoid stealing focus, ' +
      'and force=true to skip dirty-file confirmation.',
    params: {
      type: 'object',
      properties: {
        uri: { type: 'string' },
        label: { type: 'string' },
        viewColumn: { type: 'integer' },
        index: { type: 'integer' },
        preserveFocus: { type: 'boolean' },
        force: { type: 'boolean' },
      },
    },
    handler: async (raw) => {
      const p = raw as { uri?: string; label?: string; viewColumn?: number; index?: number; preserveFocus?: boolean; force?: boolean };
      const matches: vscode.Tab[] = [];
      for (const g of vscode.window.tabGroups.all) {
        for (let i = 0; i < g.tabs.length; i++) {
          const t = g.tabs[i];
          if (p.uri && tabHasUri(t, p.uri)) matches.push(t);
          else if (p.label && t.label === p.label) matches.push(t);
          else if (p.viewColumn !== undefined && p.index !== undefined && g.viewColumn === p.viewColumn && i === p.index) matches.push(t);
        }
      }
      if (matches.length === 0) return { closed: 0, message: 'No tabs matched' };
      const closed = await vscode.window.tabGroups.close(matches, p.preserveFocus);
      return { closed: closed ? matches.length : 0, requested: matches.length, force: p.force };
    },
  });

  reg({
    method: 'POST',
    path: '/tabs/closeGroup',
    summary: 'Close an entire tab group by view column',
    params: {
      type: 'object',
      properties: {
        viewColumn: { type: 'integer' },
        preserveFocus: { type: 'boolean' },
      },
      required: ['viewColumn'],
    },
    handler: async (raw) => {
      const p = raw as { viewColumn: number; preserveFocus?: boolean };
      const group = vscode.window.tabGroups.all.find((g) => g.viewColumn === p.viewColumn);
      if (!group) throw new Error(`Tab group not found at viewColumn ${p.viewColumn}`);
      const ok = await vscode.window.tabGroups.close(group, p.preserveFocus);
      return { ok };
    },
  });
}

function describeGroup(g: vscode.TabGroup, serializer: import('../serializer').Serializer): unknown {
  return {
    viewColumn: g.viewColumn,
    isActive: g.isActive,
    activeTabLabel: g.activeTab?.label ?? null,
    tabs: g.tabs.map((t) => describeTab(t, serializer)),
  };
}

function describeTab(t: vscode.Tab, serializer: import('../serializer').Serializer): unknown {
  return {
    label: t.label,
    isActive: t.isActive,
    isDirty: t.isDirty,
    isPinned: t.isPinned,
    isPreview: t.isPreview,
    input: describeTabInput(t.input, serializer),
  };
}

function describeTabInput(input: unknown, serializer: import('../serializer').Serializer): unknown {
  if (input == null) return null;
  if (input instanceof vscode.TabInputText) {
    return { kind: 'text', uri: serializer.uri(input.uri) };
  }
  if (input instanceof vscode.TabInputTextDiff) {
    return { kind: 'diff', original: serializer.uri(input.original), modified: serializer.uri(input.modified) };
  }
  if (input instanceof vscode.TabInputCustom) {
    return { kind: 'custom', viewType: input.viewType, uri: serializer.uri(input.uri) };
  }
  if (input instanceof vscode.TabInputWebview) {
    return { kind: 'webview', viewType: input.viewType };
  }
  if (input instanceof vscode.TabInputNotebook) {
    return { kind: 'notebook', notebookType: input.notebookType, uri: serializer.uri(input.uri) };
  }
  if (input instanceof vscode.TabInputNotebookDiff) {
    return {
      kind: 'notebookDiff',
      notebookType: input.notebookType,
      original: serializer.uri(input.original),
      modified: serializer.uri(input.modified),
    };
  }
  if (input instanceof vscode.TabInputTerminal) {
    return { kind: 'terminal' };
  }
  return { kind: 'unknown', __type: (input as object).constructor?.name ?? 'unknown' };
}

function tabHasUri(t: vscode.Tab, uri: string): boolean {
  const i = t.input;
  const target = vscode.Uri.parse(uri).toString();
  if (i instanceof vscode.TabInputText) return i.uri.toString() === target;
  if (i instanceof vscode.TabInputCustom) return i.uri.toString() === target;
  if (i instanceof vscode.TabInputNotebook) return i.uri.toString() === target;
  if (i instanceof vscode.TabInputTextDiff) return i.original.toString() === target || i.modified.toString() === target;
  if (i instanceof vscode.TabInputNotebookDiff) return i.original.toString() === target || i.modified.toString() === target;
  return false;
}
