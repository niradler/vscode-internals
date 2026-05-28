import * as vscode from 'vscode';
import type { EndpointRegistry } from '../registry';

/**
 * Language service endpoints — the big win over command-palette-only automation.
 * These return structured LSP responses back to the caller, not just navigation side-effects.
 *
 * All endpoints accept either an explicit `uri` + `position` pair, or operate on the active editor
 * when those are omitted (where it makes sense).
 */
export function registerLanguagesRoutes(registry: EndpointRegistry, owner: string): void {
  const reg = (def: Parameters<EndpointRegistry['register']>[0]) =>
    registry.register({ tag: 'languages', ...def }, owner);

  reg({
    method: 'GET',
    path: '/languages/all',
    summary: 'List all known language IDs',
    handler: async () => {
      const ids = await vscode.languages.getLanguages();
      return { languages: ids };
    },
  });

  reg({
    method: 'POST',
    path: '/languages/setTextDocumentLanguage',
    summary: 'Change the language ID of an open text document',
    params: {
      type: 'object',
      properties: {
        uri: { type: 'string' },
        languageId: { type: 'string', description: 'e.g. typescript, python, plaintext' },
      },
      required: ['uri', 'languageId'],
    },
    handler: async (raw, ctx) => {
      const p = raw as { uri: string; languageId: string };
      const doc = await vscode.workspace.openTextDocument(ctx.serializer.toUri(p.uri));
      const updated = await vscode.languages.setTextDocumentLanguage(doc, p.languageId);
      return ctx.serializer.textDocumentMeta(updated);
    },
  });

  reg({
    method: 'POST',
    path: '/languages/match',
    summary: 'Score a document against a DocumentSelector (language matching)',
    description:
      'Returns the match score of vscode.languages.match for the given selector against the document. ' +
      '0 means no match; higher values mean stronger match.',
    params: {
      type: 'object',
      properties: {
        uri: { type: 'string' },
        selector: {
          description: 'A language id string, or a DocumentFilter object ({language, scheme, pattern}), or an array thereof.',
        },
      },
      required: ['uri', 'selector'],
    },
    handler: async (raw, ctx) => {
      const p = raw as { uri: string; selector: unknown };
      const doc = await vscode.workspace.openTextDocument(ctx.serializer.toUri(p.uri));
      const score = vscode.languages.match(p.selector as vscode.DocumentSelector, doc);
      return { score };
    },
  });

  reg({
    method: 'POST',
    path: '/languages/diagnostics',
    summary: 'Diagnostics for a file (or all files if no uri)',
    params: {
      type: 'object',
      properties: { uri: { type: 'string', description: 'Optional; omit for full workspace diagnostics' } },
    },
    handler: (raw, ctx) => {
      const p = raw as { uri?: string };
      if (p.uri) {
        const uri = ctx.serializer.toUri(p.uri);
        return {
          uri: ctx.serializer.uri(uri),
          diagnostics: vscode.languages.getDiagnostics(uri).map((d) => ctx.serializer.diagnostic(d)),
        };
      }
      return vscode.languages.getDiagnostics().map(([u, diags]) => ({
        uri: ctx.serializer.uri(u),
        diagnostics: diags.map((d) => ctx.serializer.diagnostic(d)),
      }));
    },
  });

  reg({
    method: 'POST',
    path: '/languages/hover',
    summary: 'Hover info at position (LSP textDocument/hover)',
    params: {
      type: 'object',
      properties: { uri: { type: 'string' }, position: { type: 'object' } },
      required: ['uri', 'position'],
    },
    handler: async (raw, ctx) => {
      const p = raw as { uri: string; position: unknown };
      const uri = ctx.serializer.toUri(p.uri);
      const pos = ctx.serializer.toPosition(p.position);
      const result = await vscode.commands.executeCommand<vscode.Hover[]>('vscode.executeHoverProvider', uri, pos);
      return (result ?? []).map((h) => ctx.serializer.hover(h));
    },
  });

  reg({
    method: 'POST',
    path: '/languages/definition',
    summary: 'Go-to-definition (textDocument/definition)',
    params: {
      type: 'object',
      properties: { uri: { type: 'string' }, position: { type: 'object' } },
      required: ['uri', 'position'],
    },
    handler: async (raw, ctx) => {
      const p = raw as { uri: string; position: unknown };
      const result = await vscode.commands.executeCommand<vscode.Location[] | vscode.LocationLink[]>(
        'vscode.executeDefinitionProvider',
        ctx.serializer.toUri(p.uri),
        ctx.serializer.toPosition(p.position),
      );
      return normalizeLocations(result, ctx.serializer);
    },
  });

  reg({
    method: 'POST',
    path: '/languages/typeDefinition',
    summary: 'Go-to-type-definition',
    params: {
      type: 'object',
      properties: { uri: { type: 'string' }, position: { type: 'object' } },
      required: ['uri', 'position'],
    },
    handler: async (raw, ctx) => {
      const p = raw as { uri: string; position: unknown };
      const result = await vscode.commands.executeCommand<vscode.Location[] | vscode.LocationLink[]>(
        'vscode.executeTypeDefinitionProvider',
        ctx.serializer.toUri(p.uri),
        ctx.serializer.toPosition(p.position),
      );
      return normalizeLocations(result, ctx.serializer);
    },
  });

  reg({
    method: 'POST',
    path: '/languages/implementation',
    summary: 'Go-to-implementation',
    params: {
      type: 'object',
      properties: { uri: { type: 'string' }, position: { type: 'object' } },
      required: ['uri', 'position'],
    },
    handler: async (raw, ctx) => {
      const p = raw as { uri: string; position: unknown };
      const result = await vscode.commands.executeCommand<vscode.Location[] | vscode.LocationLink[]>(
        'vscode.executeImplementationProvider',
        ctx.serializer.toUri(p.uri),
        ctx.serializer.toPosition(p.position),
      );
      return normalizeLocations(result, ctx.serializer);
    },
  });

  reg({
    method: 'POST',
    path: '/languages/references',
    summary: 'Find all references',
    params: {
      type: 'object',
      properties: { uri: { type: 'string' }, position: { type: 'object' } },
      required: ['uri', 'position'],
    },
    handler: async (raw, ctx) => {
      const p = raw as { uri: string; position: unknown };
      const result = await vscode.commands.executeCommand<vscode.Location[]>(
        'vscode.executeReferenceProvider',
        ctx.serializer.toUri(p.uri),
        ctx.serializer.toPosition(p.position),
      );
      return (result ?? []).map((l) => ctx.serializer.location(l));
    },
  });

  reg({
    method: 'POST',
    path: '/languages/documentSymbols',
    summary: 'Document outline (symbols within a file)',
    params: { type: 'object', properties: { uri: { type: 'string' } }, required: ['uri'] },
    handler: async (raw, ctx) => {
      const p = raw as { uri: string };
      const result = await vscode.commands.executeCommand<vscode.DocumentSymbol[] | vscode.SymbolInformation[]>(
        'vscode.executeDocumentSymbolProvider',
        ctx.serializer.toUri(p.uri),
      );
      if (!result) return [];
      // The provider returns either DocumentSymbol[] (hierarchical) or SymbolInformation[] (flat).
      if (result.length > 0 && 'children' in result[0]) {
        return (result as vscode.DocumentSymbol[]).map((s) => ctx.serializer.documentSymbol(s));
      }
      return (result as vscode.SymbolInformation[]).map((s) => ctx.serializer.symbolInformation(s));
    },
  });

  reg({
    method: 'POST',
    path: '/languages/workspaceSymbols',
    summary: 'Search workspace symbols by query string',
    params: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
    handler: async (raw, ctx) => {
      const p = raw as { query: string };
      const result = await vscode.commands.executeCommand<vscode.SymbolInformation[]>(
        'vscode.executeWorkspaceSymbolProvider', p.query,
      );
      return (result ?? []).map((s) => ctx.serializer.symbolInformation(s));
    },
  });

  reg({
    method: 'POST',
    path: '/languages/completions',
    summary: 'Code completions at position',
    params: {
      type: 'object',
      properties: {
        uri: { type: 'string' },
        position: { type: 'object' },
        triggerCharacter: { type: 'string' },
      },
      required: ['uri', 'position'],
    },
    handler: async (raw, ctx) => {
      const p = raw as { uri: string; position: unknown; triggerCharacter?: string };
      const list = await vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider',
        ctx.serializer.toUri(p.uri),
        ctx.serializer.toPosition(p.position),
        p.triggerCharacter,
      );
      if (!list) return { isIncomplete: false, items: [] };
      return {
        isIncomplete: list.isIncomplete,
        items: list.items.map((item) => ({
          label: typeof item.label === 'string' ? item.label : item.label.label,
          kind: item.kind !== undefined ? vscode.CompletionItemKind[item.kind] : undefined,
          detail: item.detail,
          documentation: typeof item.documentation === 'string'
            ? item.documentation
            : item.documentation && 'value' in item.documentation ? item.documentation.value : undefined,
          insertText: typeof item.insertText === 'string' ? item.insertText
            : item.insertText && 'value' in item.insertText ? item.insertText.value : undefined,
          sortText: item.sortText,
          filterText: item.filterText,
          preselect: item.preselect,
        })),
      };
    },
  });

  reg({
    method: 'POST',
    path: '/languages/signatureHelp',
    summary: 'Signature help at position',
    params: {
      type: 'object',
      properties: { uri: { type: 'string' }, position: { type: 'object' } },
      required: ['uri', 'position'],
    },
    handler: async (raw, ctx) => {
      const p = raw as { uri: string; position: unknown };
      const help = await vscode.commands.executeCommand<vscode.SignatureHelp>(
        'vscode.executeSignatureHelpProvider',
        ctx.serializer.toUri(p.uri),
        ctx.serializer.toPosition(p.position),
      );
      if (!help) return null;
      return {
        activeSignature: help.activeSignature,
        activeParameter: help.activeParameter,
        signatures: help.signatures.map((s) => ({
          label: s.label,
          documentation: typeof s.documentation === 'string' ? s.documentation
            : s.documentation && 'value' in s.documentation ? s.documentation.value : undefined,
          parameters: s.parameters?.map((p2) => ({
            label: p2.label,
            documentation: typeof p2.documentation === 'string' ? p2.documentation
              : p2.documentation && 'value' in p2.documentation ? p2.documentation.value : undefined,
          })),
        })),
      };
    },
  });

  reg({
    method: 'POST',
    path: '/languages/codeActions',
    summary: 'Code actions available in a range',
    params: {
      type: 'object',
      properties: {
        uri: { type: 'string' },
        range: { type: 'object' },
        only: { type: 'string', description: 'Optional CodeActionKind to filter (e.g. refactor, quickfix)' },
      },
      required: ['uri', 'range'],
    },
    handler: async (raw, ctx) => {
      const p = raw as { uri: string; range: unknown; only?: string };
      const actions = await vscode.commands.executeCommand<Array<vscode.CodeAction | vscode.Command>>(
        'vscode.executeCodeActionProvider',
        ctx.serializer.toUri(p.uri),
        ctx.serializer.toRange(p.range),
        p.only,
      );
      return (actions ?? []).map((a) => {
        if (typeof (a as vscode.Command).command === 'string') {
          const cmd = a as vscode.Command;
          return { kind: 'command', title: cmd.title, command: cmd.command, arguments: cmd.arguments };
        }
        const ca = a as vscode.CodeAction;
        return {
          kind: 'codeAction',
          title: ca.title,
          actionKind: ca.kind?.value,
          isPreferred: ca.isPreferred,
          disabled: ca.disabled?.reason,
          command: ca.command ? { title: ca.command.title, command: ca.command.command } : undefined,
        };
      });
    },
  });

  reg({
    method: 'POST',
    path: '/languages/rename',
    summary: 'Rename symbol at position (returns the edits that would be applied)',
    params: {
      type: 'object',
      properties: { uri: { type: 'string' }, position: { type: 'object' }, newName: { type: 'string' }, apply: { type: 'boolean' } },
      required: ['uri', 'position', 'newName'],
    },
    handler: async (raw, ctx) => {
      const p = raw as { uri: string; position: unknown; newName: string; apply?: boolean };
      const edit = await vscode.commands.executeCommand<vscode.WorkspaceEdit>(
        'vscode.executeDocumentRenameProvider',
        ctx.serializer.toUri(p.uri),
        ctx.serializer.toPosition(p.position),
        p.newName,
      );
      if (!edit) return { applied: false, edits: [] };
      const summary: Array<{ uri: unknown; changes: Array<{ range: unknown; newText: string }> }> = [];
      for (const [u, edits] of edit.entries()) {
        summary.push({
          uri: ctx.serializer.uri(u),
          changes: edits.map((e) => ({ range: ctx.serializer.range(e.range), newText: e.newText })),
        });
      }
      let applied = false;
      if (p.apply) applied = await vscode.workspace.applyEdit(edit);
      return { applied, edits: summary };
    },
  });

  reg({
    method: 'POST',
    path: '/languages/formatDocument',
    summary: 'Format an entire document and (optionally) apply the formatting edits',
    params: {
      type: 'object',
      properties: { uri: { type: 'string' }, apply: { type: 'boolean' } },
      required: ['uri'],
    },
    handler: async (raw, ctx) => {
      const p = raw as { uri: string; apply?: boolean };
      const uri = ctx.serializer.toUri(p.uri);
      const edits = await vscode.commands.executeCommand<vscode.TextEdit[]>(
        'vscode.executeFormatDocumentProvider', uri,
      );
      const edits2 = edits ?? [];
      let applied = false;
      if (p.apply && edits2.length > 0) {
        const wsEdit = new vscode.WorkspaceEdit();
        for (const e of edits2) wsEdit.replace(uri, e.range, e.newText);
        applied = await vscode.workspace.applyEdit(wsEdit);
      }
      return {
        applied,
        edits: edits2.map((e) => ({ range: ctx.serializer.range(e.range), newText: e.newText })),
      };
    },
  });
}

function normalizeLocations(
  result: vscode.Location[] | vscode.LocationLink[] | undefined,
  serializer: import('../serializer').Serializer,
): unknown[] {
  if (!result) return [];
  return result.map((r) => {
    if ('targetUri' in r) {
      return {
        uri: serializer.uri(r.targetUri),
        range: serializer.range(r.targetRange),
        selectionRange: serializer.range(r.targetSelectionRange),
        originSelectionRange: r.originSelectionRange ? serializer.range(r.originSelectionRange) : undefined,
      };
    }
    return serializer.location(r);
  });
}
