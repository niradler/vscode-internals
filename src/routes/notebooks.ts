import * as vscode from 'vscode';
import type { EndpointRegistry } from '../registry';

export function registerNotebooksRoutes(registry: EndpointRegistry, owner: string): void {
  const reg = (def: Parameters<EndpointRegistry['register']>[0]) =>
    registry.register({ tag: 'notebooks', ...def }, owner);

  reg({
    method: 'GET',
    path: '/notebooks/open',
    summary: 'List open notebook documents',
    handler: (_, ctx) => vscode.workspace.notebookDocuments.map((nb) => describeNotebook(nb, ctx.serializer)),
  });

  reg({
    method: 'POST',
    path: '/notebooks/openNotebookDocument',
    summary: 'Open a notebook document by URI',
    params: { type: 'object', properties: { uri: { type: 'string' } }, required: ['uri'] },
    handler: async (raw, ctx) => {
      const p = raw as { uri: string };
      const nb = await vscode.workspace.openNotebookDocument(ctx.serializer.toUri(p.uri));
      return describeNotebook(nb, ctx.serializer);
    },
  });

  reg({
    method: 'POST',
    path: '/notebooks/cells',
    summary: 'Cells of a notebook document (with optional range)',
    params: {
      type: 'object',
      properties: {
        uri: { type: 'string' },
        start: { type: 'integer' },
        end: { type: 'integer' },
      },
      required: ['uri'],
    },
    handler: async (raw, ctx) => {
      const p = raw as { uri: string; start?: number; end?: number };
      const nb = await vscode.workspace.openNotebookDocument(ctx.serializer.toUri(p.uri));
      const start = p.start ?? 0;
      const end = p.end ?? nb.cellCount;
      const cells: unknown[] = [];
      for (let i = start; i < end && i < nb.cellCount; i++) {
        cells.push(describeCell(nb.cellAt(i), ctx.serializer));
      }
      return { cells };
    },
  });
}

function describeNotebook(nb: vscode.NotebookDocument, serializer: import('../serializer').Serializer): unknown {
  return {
    uri: serializer.uri(nb.uri),
    notebookType: nb.notebookType,
    version: nb.version,
    isDirty: nb.isDirty,
    isUntitled: nb.isUntitled,
    isClosed: nb.isClosed,
    cellCount: nb.cellCount,
    metadata: nb.metadata,
  };
}

function describeCell(cell: vscode.NotebookCell, serializer: import('../serializer').Serializer): unknown {
  return {
    index: cell.index,
    kind: cell.kind === vscode.NotebookCellKind.Code ? 'code' : 'markup',
    languageId: cell.document.languageId,
    text: cell.document.getText(),
    metadata: cell.metadata,
    executionSummary: cell.executionSummary
      ? { executionOrder: cell.executionSummary.executionOrder, success: cell.executionSummary.success }
      : undefined,
    outputs: cell.outputs.map((o) => ({
      items: o.items.map((it) => ({ mime: it.mime, length: it.data.byteLength })),
      metadata: o.metadata,
    })),
    uri: serializer.uri(cell.document.uri),
  };
}
