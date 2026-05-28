import * as vscode from 'vscode';

/**
 * Bidirectional translation between vscode.* types and plain JSON.
 *
 * Inbound (JSON from client) -> vscode constructors via helpers like toUri/toRange/toPosition.
 * Outbound (vscode obj from API) -> plain serializable shapes via the serialize* methods.
 *
 * The serializer never returns vscode instances in its output; everything is JSON-safe.
 */
export class Serializer {
  // ---------- Outbound ----------

  uri(u: vscode.Uri | undefined | null): UriJSON | null {
    if (!u) return null;
    return {
      scheme: u.scheme,
      authority: u.authority,
      path: u.path,
      query: u.query,
      fragment: u.fragment,
      fsPath: u.fsPath,
      toString: u.toString(),
    };
  }

  position(p: vscode.Position | undefined | null): PositionJSON | null {
    if (!p) return null;
    return { line: p.line, character: p.character };
  }

  range(r: vscode.Range | undefined | null): RangeJSON | null {
    if (!r) return null;
    return { start: this.position(r.start)!, end: this.position(r.end)! };
  }

  selection(s: vscode.Selection | undefined | null): SelectionJSON | null {
    if (!s) return null;
    return {
      anchor: this.position(s.anchor)!,
      active: this.position(s.active)!,
      start: this.position(s.start)!,
      end: this.position(s.end)!,
      isReversed: s.isReversed,
      isEmpty: s.isEmpty,
    };
  }

  location(l: vscode.Location | undefined | null): LocationJSON | null {
    if (!l) return null;
    return { uri: this.uri(l.uri)!, range: this.range(l.range)! };
  }

  textDocumentMeta(d: vscode.TextDocument): TextDocumentMetaJSON {
    return {
      uri: this.uri(d.uri)!,
      languageId: d.languageId,
      version: d.version,
      lineCount: d.lineCount,
      isDirty: d.isDirty,
      isUntitled: d.isUntitled,
      isClosed: d.isClosed,
      eol: d.eol === vscode.EndOfLine.LF ? 'LF' : 'CRLF',
      fileName: d.fileName,
    };
  }

  textEditor(e: vscode.TextEditor): TextEditorJSON {
    return {
      document: this.textDocumentMeta(e.document),
      selections: e.selections.map((s) => this.selection(s)!),
      selection: this.selection(e.selection)!,
      visibleRanges: e.visibleRanges.map((r) => this.range(r)!),
      options: {
        tabSize: e.options.tabSize,
        insertSpaces: e.options.insertSpaces,
        cursorStyle: e.options.cursorStyle,
        lineNumbers: e.options.lineNumbers,
      },
      viewColumn: e.viewColumn ?? null,
    };
  }

  diagnostic(d: vscode.Diagnostic): DiagnosticJSON {
    return {
      range: this.range(d.range)!,
      message: d.message,
      severity: severityName(d.severity),
      source: d.source,
      code: d.code === undefined ? undefined : typeof d.code === 'object'
        ? { value: String(d.code.value), target: this.uri(d.code.target) }
        : d.code,
      tags: d.tags,
      relatedInformation: d.relatedInformation?.map((r) => ({
        location: this.location(r.location)!,
        message: r.message,
      })),
    };
  }

  symbolInformation(s: vscode.SymbolInformation): SymbolInformationJSON {
    return {
      name: s.name,
      kind: symbolKindName(s.kind),
      containerName: s.containerName,
      location: this.location(s.location)!,
    };
  }

  documentSymbol(s: vscode.DocumentSymbol): DocumentSymbolJSON {
    return {
      name: s.name,
      detail: s.detail,
      kind: symbolKindName(s.kind),
      range: this.range(s.range)!,
      selectionRange: this.range(s.selectionRange)!,
      children: s.children?.map((c) => this.documentSymbol(c)) ?? [],
    };
  }

  hover(h: vscode.Hover): HoverJSON {
    return {
      range: this.range(h.range),
      contents: h.contents.map((c) => {
        if (typeof c === 'string') return c;
        // MarkdownString
        if ('value' in c) return c.value;
        return String(c);
      }),
    };
  }

  workspaceFolder(f: vscode.WorkspaceFolder): WorkspaceFolderJSON {
    return { uri: this.uri(f.uri)!, name: f.name, index: f.index };
  }

  // ---------- Inbound ----------

  toUri(input: unknown): vscode.Uri {
    if (typeof input === 'string') {
      // Accept both URI strings and file paths.
      if (/^[a-z][a-z0-9+.-]*:/i.test(input)) return vscode.Uri.parse(input);
      return vscode.Uri.file(input);
    }
    if (input && typeof input === 'object') {
      const u = input as Partial<UriJSON>;
      if (u.scheme === 'file' && typeof u.fsPath === 'string') return vscode.Uri.file(u.fsPath);
      if (typeof u.toString === 'string') return vscode.Uri.parse(u.toString);
      if (u.scheme !== undefined) {
        return vscode.Uri.from({
          scheme: u.scheme,
          authority: u.authority,
          path: u.path,
          query: u.query,
          fragment: u.fragment,
        });
      }
    }
    throw new TypeError('Invalid URI input');
  }

  toPosition(input: unknown): vscode.Position {
    const p = input as Partial<PositionJSON>;
    if (typeof p?.line !== 'number' || typeof p?.character !== 'number') {
      throw new TypeError('Invalid Position: expected { line, character }');
    }
    return new vscode.Position(p.line, p.character);
  }

  toRange(input: unknown): vscode.Range {
    const r = input as Partial<RangeJSON>;
    if (!r?.start || !r?.end) throw new TypeError('Invalid Range: expected { start, end }');
    return new vscode.Range(this.toPosition(r.start), this.toPosition(r.end));
  }
}

function severityName(s: vscode.DiagnosticSeverity): string {
  switch (s) {
    case vscode.DiagnosticSeverity.Error: return 'error';
    case vscode.DiagnosticSeverity.Warning: return 'warning';
    case vscode.DiagnosticSeverity.Information: return 'information';
    case vscode.DiagnosticSeverity.Hint: return 'hint';
    default: return 'unknown';
  }
}

function symbolKindName(k: vscode.SymbolKind): string {
  // vscode.SymbolKind is a numeric enum
  return vscode.SymbolKind[k] ?? `kind_${k}`;
}

// JSON-shape types are co-located for ease of import.
export interface UriJSON {
  scheme: string;
  authority: string;
  path: string;
  query: string;
  fragment: string;
  fsPath: string;
  toString: string;
}

export interface PositionJSON { line: number; character: number; }
export interface RangeJSON { start: PositionJSON; end: PositionJSON; }
export interface SelectionJSON extends RangeJSON {
  anchor: PositionJSON;
  active: PositionJSON;
  isReversed: boolean;
  isEmpty: boolean;
}
export interface LocationJSON { uri: UriJSON; range: RangeJSON; }
export interface TextDocumentMetaJSON {
  uri: UriJSON;
  languageId: string;
  version: number;
  lineCount: number;
  isDirty: boolean;
  isUntitled: boolean;
  isClosed: boolean;
  eol: 'LF' | 'CRLF';
  fileName: string;
}
export interface TextEditorJSON {
  document: TextDocumentMetaJSON;
  selections: SelectionJSON[];
  selection: SelectionJSON;
  visibleRanges: RangeJSON[];
  options: { tabSize?: number | string; insertSpaces?: boolean | string; cursorStyle?: unknown; lineNumbers?: unknown };
  viewColumn: number | null;
}
export interface DiagnosticJSON {
  range: RangeJSON;
  message: string;
  severity: string;
  source?: string;
  code?: unknown;
  tags?: vscode.DiagnosticTag[];
  relatedInformation?: Array<{ location: LocationJSON; message: string }>;
}
export interface SymbolInformationJSON {
  name: string;
  kind: string;
  containerName: string;
  location: LocationJSON;
}
export interface DocumentSymbolJSON {
  name: string;
  detail: string;
  kind: string;
  range: RangeJSON;
  selectionRange: RangeJSON;
  children: DocumentSymbolJSON[];
}
export interface HoverJSON {
  range: RangeJSON | null;
  contents: string[];
}
export interface WorkspaceFolderJSON {
  uri: UriJSON;
  name: string;
  index: number;
}
