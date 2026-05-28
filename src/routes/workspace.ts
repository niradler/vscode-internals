import * as vscode from 'vscode';
import type { EndpointRegistry } from '../registry';

export function registerWorkspaceRoutes(registry: EndpointRegistry, owner: string): void {
  const reg = (def: Parameters<EndpointRegistry['register']>[0]) =>
    registry.register({ tag: 'workspace', ...def }, owner);

  reg({
    method: 'GET',
    path: '/workspace/folders',
    summary: 'List workspace folders',
    response: { type: 'array' },
    handler: (_, ctx) => (vscode.workspace.workspaceFolders ?? []).map((f) => ctx.serializer.workspaceFolder(f)),
  });

  reg({
    method: 'GET',
    path: '/workspace/name',
    summary: 'Workspace name and root path',
    handler: () => ({
      name: vscode.workspace.name ?? null,
      workspaceFile: vscode.workspace.workspaceFile?.toString() ?? null,
      rootPath: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? null,
    }),
  });

  reg({
    method: 'POST',
    path: '/workspace/findFiles',
    summary: 'Glob-search workspace files (proxy for vscode.workspace.findFiles)',
    params: {
      type: 'object',
      properties: {
        include: { type: 'string', description: 'Glob include pattern (e.g. **/*.ts)' },
        exclude: { type: 'string', description: 'Glob exclude pattern (optional)' },
        maxResults: { type: 'integer', description: 'Limit results (default 1000)' },
      },
      required: ['include'],
    },
    handler: async (raw, ctx) => {
      const p = raw as { include: string; exclude?: string; maxResults?: number };
      const uris = await vscode.workspace.findFiles(p.include, p.exclude, p.maxResults ?? 1000);
      return uris.map((u) => ctx.serializer.uri(u));
    },
  });

  reg({
    method: 'POST',
    path: '/workspace/readFile',
    summary: 'Read a file via vscode.workspace.fs (works across filesystems including remote)',
    params: {
      type: 'object',
      properties: {
        uri: { type: 'string', description: 'URI string or absolute file path' },
        encoding: { type: 'string', enum: ['utf8', 'base64'], description: 'Default utf8' },
      },
      required: ['uri'],
    },
    handler: async (raw, ctx) => {
      const p = raw as { uri: string; encoding?: 'utf8' | 'base64' };
      const uri = ctx.serializer.toUri(p.uri);
      const bytes = await vscode.workspace.fs.readFile(uri);
      const encoding = p.encoding ?? 'utf8';
      const content = encoding === 'base64'
        ? Buffer.from(bytes).toString('base64')
        : Buffer.from(bytes).toString('utf8');
      return { uri: ctx.serializer.uri(uri), encoding, size: bytes.byteLength, content };
    },
  });

  reg({
    method: 'POST',
    path: '/workspace/writeFile',
    summary: 'Write a file via vscode.workspace.fs',
    params: {
      type: 'object',
      properties: {
        uri: { type: 'string' },
        content: { type: 'string' },
        encoding: { type: 'string', enum: ['utf8', 'base64'], description: 'Default utf8' },
      },
      required: ['uri', 'content'],
    },
    handler: async (raw, ctx) => {
      const p = raw as { uri: string; content: string; encoding?: 'utf8' | 'base64' };
      const uri = ctx.serializer.toUri(p.uri);
      const bytes = p.encoding === 'base64' ? Buffer.from(p.content, 'base64') : Buffer.from(p.content, 'utf8');
      await vscode.workspace.fs.writeFile(uri, bytes);
      return { uri: ctx.serializer.uri(uri), bytesWritten: bytes.byteLength };
    },
  });

  reg({
    method: 'POST',
    path: '/workspace/stat',
    summary: 'Stat a file/directory',
    params: { type: 'object', properties: { uri: { type: 'string' } }, required: ['uri'] },
    handler: async (raw, ctx) => {
      const p = raw as { uri: string };
      const uri = ctx.serializer.toUri(p.uri);
      const stat = await vscode.workspace.fs.stat(uri);
      return {
        uri: ctx.serializer.uri(uri),
        type: vscode.FileType[stat.type] ?? stat.type,
        size: stat.size,
        ctime: stat.ctime,
        mtime: stat.mtime,
      };
    },
  });

  reg({
    method: 'POST',
    path: '/workspace/readDirectory',
    summary: 'List children of a directory',
    params: { type: 'object', properties: { uri: { type: 'string' } }, required: ['uri'] },
    handler: async (raw, ctx) => {
      const p = raw as { uri: string };
      const uri = ctx.serializer.toUri(p.uri);
      const entries = await vscode.workspace.fs.readDirectory(uri);
      return entries.map(([name, type]) => ({ name, type: vscode.FileType[type] ?? type }));
    },
  });

  reg({
    method: 'POST',
    path: '/workspace/createDirectory',
    summary: 'Create a directory (recursive)',
    params: { type: 'object', properties: { uri: { type: 'string' } }, required: ['uri'] },
    handler: async (raw, ctx) => {
      const p = raw as { uri: string };
      const uri = ctx.serializer.toUri(p.uri);
      await vscode.workspace.fs.createDirectory(uri);
      return { ok: true };
    },
  });

  reg({
    method: 'POST',
    path: '/workspace/delete',
    summary: 'Delete a file or directory',
    params: {
      type: 'object',
      properties: {
        uri: { type: 'string' },
        recursive: { type: 'boolean' },
        useTrash: { type: 'boolean', description: 'Move to OS trash instead of permanent delete' },
      },
      required: ['uri'],
    },
    handler: async (raw, ctx) => {
      const p = raw as { uri: string; recursive?: boolean; useTrash?: boolean };
      const uri = ctx.serializer.toUri(p.uri);
      await vscode.workspace.fs.delete(uri, { recursive: p.recursive ?? false, useTrash: p.useTrash ?? false });
      return { ok: true };
    },
  });

  reg({
    method: 'POST',
    path: '/workspace/copy',
    summary: 'Copy a file or directory',
    params: {
      type: 'object',
      properties: { source: { type: 'string' }, target: { type: 'string' }, overwrite: { type: 'boolean' } },
      required: ['source', 'target'],
    },
    handler: async (raw, ctx) => {
      const p = raw as { source: string; target: string; overwrite?: boolean };
      await vscode.workspace.fs.copy(
        ctx.serializer.toUri(p.source),
        ctx.serializer.toUri(p.target),
        { overwrite: p.overwrite ?? false },
      );
      return { ok: true };
    },
  });

  reg({
    method: 'POST',
    path: '/workspace/rename',
    summary: 'Rename / move a file or directory',
    params: {
      type: 'object',
      properties: { source: { type: 'string' }, target: { type: 'string' }, overwrite: { type: 'boolean' } },
      required: ['source', 'target'],
    },
    handler: async (raw, ctx) => {
      const p = raw as { source: string; target: string; overwrite?: boolean };
      await vscode.workspace.fs.rename(
        ctx.serializer.toUri(p.source),
        ctx.serializer.toUri(p.target),
        { overwrite: p.overwrite ?? false },
      );
      return { ok: true };
    },
  });

  reg({
    method: 'GET',
    path: '/workspace/textDocuments',
    summary: 'List all currently open text documents (including unfocused ones)',
    handler: (_, ctx) => vscode.workspace.textDocuments.map((d) => ctx.serializer.textDocumentMeta(d)),
  });

  reg({
    method: 'POST',
    path: '/workspace/getWorkspaceFolder',
    summary: 'Find which workspace folder owns a given URI',
    params: { type: 'object', properties: { uri: { type: 'string' } }, required: ['uri'] },
    handler: (raw, ctx) => {
      const p = raw as { uri: string };
      const folder = vscode.workspace.getWorkspaceFolder(ctx.serializer.toUri(p.uri));
      return folder ? ctx.serializer.workspaceFolder(folder) : null;
    },
  });

  reg({
    method: 'POST',
    path: '/workspace/asRelativePath',
    summary: 'Convert a URI/path to a workspace-relative path',
    params: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'URI string or absolute path' },
        includeWorkspaceFolder: { type: 'boolean' },
      },
      required: ['path'],
    },
    handler: (raw) => {
      const p = raw as { path: string; includeWorkspaceFolder?: boolean };
      const input = p.path.includes('://') ? vscode.Uri.parse(p.path) : p.path;
      const rel = vscode.workspace.asRelativePath(input, p.includeWorkspaceFolder ?? true);
      return { relative: rel };
    },
  });

  reg({
    method: 'POST',
    path: '/workspace/updateWorkspaceFolders',
    summary: 'Add, remove, or replace workspace folders',
    description:
      'Wraps vscode.workspace.updateWorkspaceFolders. Use `add` to append folders without removing any ' +
      '(start at the end), or `replace` to mutate at a specific index. To remove folders, pass start/' +
      'deleteCount with no folders.',
    params: {
      type: 'object',
      properties: {
        start: { type: 'integer' },
        deleteCount: { type: 'integer' },
        folders: {
          type: 'array',
          items: {
            type: 'object',
            properties: { uri: { type: 'string' }, name: { type: 'string' } },
            required: ['uri'],
          },
        },
      },
      required: ['start', 'deleteCount'],
    },
    handler: (raw, ctx) => {
      const p = raw as { start: number; deleteCount: number; folders?: Array<{ uri: string; name?: string }> };
      const folderArgs = (p.folders ?? []).map((f) => ({
        uri: ctx.serializer.toUri(f.uri),
        name: f.name,
      }));
      const ok = vscode.workspace.updateWorkspaceFolders(p.start, p.deleteCount, ...folderArgs);
      return { ok };
    },
  });

  reg({
    method: 'POST',
    path: '/workspace/openTextDocument',
    summary: 'Open a text document (does not focus it). Returns metadata.',
    params: {
      type: 'object',
      properties: {
        uri: { type: 'string' },
        content: { type: 'string', description: 'When provided, opens an untitled document with this content' },
        language: { type: 'string' },
      },
    },
    handler: async (raw, ctx) => {
      const p = raw as { uri?: string; content?: string; language?: string };
      let doc: vscode.TextDocument;
      if (p.content !== undefined) {
        doc = await vscode.workspace.openTextDocument({ content: p.content, language: p.language });
      } else if (p.uri) {
        doc = await vscode.workspace.openTextDocument(ctx.serializer.toUri(p.uri));
      } else {
        throw new Error('Provide either uri or content');
      }
      return ctx.serializer.textDocumentMeta(doc);
    },
  });

  reg({
    method: 'POST',
    path: '/workspace/getDocumentText',
    summary: 'Read full text content of an opened document by URI',
    params: {
      type: 'object',
      properties: { uri: { type: 'string' }, range: { type: 'object' } },
      required: ['uri'],
    },
    handler: async (raw, ctx) => {
      const p = raw as { uri: string; range?: unknown };
      const uri = ctx.serializer.toUri(p.uri);
      const doc = await vscode.workspace.openTextDocument(uri);
      const range = p.range ? ctx.serializer.toRange(p.range) : undefined;
      return { uri: ctx.serializer.uri(uri), text: doc.getText(range) };
    },
  });

  reg({
    method: 'POST',
    path: '/workspace/saveAll',
    summary: 'Save all dirty documents',
    params: { type: 'object', properties: { includeUntitled: { type: 'boolean' } } },
    handler: async (raw) => {
      const p = raw as { includeUntitled?: boolean };
      const saved = await vscode.workspace.saveAll(p.includeUntitled ?? false);
      return { saved };
    },
  });

  reg({
    method: 'POST',
    path: '/workspace/applyEdit',
    summary: 'Apply a WorkspaceEdit (multiple file edits atomically)',
    params: {
      type: 'object',
      properties: {
        edits: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              uri: { type: 'string' },
              changes: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    range: { type: 'object', description: '{ start: {line,character}, end: {line,character} }' },
                    newText: { type: 'string' },
                  },
                  required: ['range', 'newText'],
                },
              },
            },
            required: ['uri', 'changes'],
          },
        },
      },
      required: ['edits'],
    },
    handler: async (raw, ctx) => {
      const p = raw as { edits: Array<{ uri: string; changes: Array<{ range: unknown; newText: string }> }> };
      const wsEdit = new vscode.WorkspaceEdit();
      for (const fileEdit of p.edits) {
        const uri = ctx.serializer.toUri(fileEdit.uri);
        for (const change of fileEdit.changes) {
          wsEdit.replace(uri, ctx.serializer.toRange(change.range), change.newText);
        }
      }
      const success = await vscode.workspace.applyEdit(wsEdit);
      return { success };
    },
  });

  // ---- Configuration ----

  reg({
    method: 'GET',
    path: '/workspace/configuration',
    summary: 'Read a configuration value (vscode.workspace.getConfiguration)',
    params: {
      type: 'object',
      properties: {
        section: { type: 'string', description: 'e.g. editor.fontSize or editor (returns the section tree)' },
        scopeUri: { type: 'string', description: 'Optional URI to scope folder-specific settings' },
      },
    },
    handler: (raw) => {
      const p = raw as { section?: string; scopeUri?: string };
      const scope = p.scopeUri ? vscode.Uri.parse(p.scopeUri) : undefined;
      const cfg = vscode.workspace.getConfiguration(undefined, scope);
      if (!p.section) return { keys: getKeys(cfg) };
      const value = cfg.get(p.section);
      const inspect = cfg.inspect(p.section);
      return { section: p.section, value, inspect };
    },
  });

  reg({
    method: 'POST',
    path: '/workspace/updateConfiguration',
    summary: 'Update a configuration value',
    params: {
      type: 'object',
      properties: {
        section: { type: 'string' },
        value: { description: 'New value (any JSON-serializable). null deletes the override.' },
        target: { type: 'string', enum: ['global', 'workspace', 'workspaceFolder'], description: 'Default workspace' },
        scopeUri: { type: 'string' },
      },
      required: ['section'],
    },
    handler: async (raw) => {
      const p = raw as { section: string; value: unknown; target?: 'global' | 'workspace' | 'workspaceFolder'; scopeUri?: string };
      const scope = p.scopeUri ? vscode.Uri.parse(p.scopeUri) : undefined;
      const cfg = vscode.workspace.getConfiguration(undefined, scope);
      const target =
        p.target === 'global' ? vscode.ConfigurationTarget.Global :
          p.target === 'workspaceFolder' ? vscode.ConfigurationTarget.WorkspaceFolder :
            vscode.ConfigurationTarget.Workspace;
      await cfg.update(p.section, p.value, target);
      return { ok: true };
    },
  });
}

function getKeys(cfg: vscode.WorkspaceConfiguration): string[] {
  // Enumerate own keys — Workspace configuration is a Proxy; reflect on its descriptors.
  const out: string[] = [];
  for (const k of Object.keys(cfg)) {
    if (typeof (cfg as unknown as Record<string, unknown>)[k] !== 'function') out.push(k);
  }
  return out;
}
