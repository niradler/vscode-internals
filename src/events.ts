import type { Response } from 'express';
import * as vscode from 'vscode';
import type { Logger } from './logger';
import type { Serializer } from './serializer';

/**
 * EventBus turns vscode.Event<T> streams into SSE messages.
 *
 * The set of supported events is fixed at construction (one factory per name). The handler
 * is registered lazily — the first subscriber triggers vscode.Event registration; the last
 * unsubscriber tears it down. This avoids holding listeners we don't need.
 */
export class EventBus {
  private factories = new Map<string, EventFactory>();
  private active = new Map<string, ActiveEvent>();
  private nextSubId = 1;

  constructor(private logger: Logger) {}

  registerEventSource(name: string, factory: EventFactory): void {
    this.factories.set(name, factory);
  }

  listAvailable(): string[] {
    return [...this.factories.keys()].sort();
  }

  /**
   * Attach a subscriber to one or more event names. Returns a function to unsubscribe.
   * The subscriber receives parsed JSON-serializable payloads.
   */
  subscribe(names: string[], onEvent: (eventName: string, payload: unknown) => void): () => void {
    const unknownNames = names.filter((n) => !this.factories.has(n));
    if (unknownNames.length > 0) {
      throw new Error(`Unknown event(s): ${unknownNames.join(', ')}. Available: ${this.listAvailable().join(', ')}`);
    }
    const subId = this.nextSubId++;
    const attached: Array<{ name: string; dispose: vscode.Disposable }> = [];
    for (const name of names) {
      const active = this.ensureActive(name);
      const dispose = active.addSubscriber(subId, onEvent);
      attached.push({ name, dispose });
    }
    return () => {
      for (const a of attached) {
        a.dispose.dispose();
        const active = this.active.get(a.name);
        if (active && active.subscriberCount === 0) {
          active.disposeSource();
          this.active.delete(a.name);
        }
      }
    };
  }

  private ensureActive(name: string): ActiveEvent {
    let active = this.active.get(name);
    if (active) return active;
    const factory = this.factories.get(name)!;
    active = new ActiveEvent(name, factory, this.logger);
    this.active.set(name, active);
    return active;
  }

  dispose(): void {
    for (const active of this.active.values()) {
      active.disposeSource();
    }
    this.active.clear();
  }
}

export type EventFactory = (emit: (payload: unknown) => void) => vscode.Disposable;

class ActiveEvent {
  private subscribers = new Map<number, (eventName: string, payload: unknown) => void>();
  private sourceDisposable?: vscode.Disposable;

  constructor(private name: string, private factory: EventFactory, private logger: Logger) {}

  get subscriberCount(): number { return this.subscribers.size; }

  addSubscriber(id: number, fn: (eventName: string, payload: unknown) => void): vscode.Disposable {
    this.subscribers.set(id, fn);
    if (!this.sourceDisposable) {
      try {
        this.sourceDisposable = this.factory((payload) => this.dispatch(payload));
      } catch (err) {
        this.logger.error(`Failed to register event source ${this.name}`, err);
        this.subscribers.delete(id);
        throw err;
      }
    }
    return { dispose: () => this.subscribers.delete(id) };
  }

  disposeSource(): void {
    this.sourceDisposable?.dispose();
    this.sourceDisposable = undefined;
    this.subscribers.clear();
  }

  private dispatch(payload: unknown): void {
    for (const fn of this.subscribers.values()) {
      try { fn(this.name, payload); } catch (err) {
        this.logger.warn(`subscriber to ${this.name} threw`, err);
      }
    }
  }
}

/**
 * Bind the standard vscode events into an EventBus. Each event factory translates the
 * vscode payload into a JSON-friendly shape via the serializer.
 */
export function registerStandardEvents(bus: EventBus, serializer: Serializer): void {
  bus.registerEventSource('onDidChangeActiveTextEditor', (emit) =>
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      emit(editor ? serializer.textEditor(editor) : null);
    }),
  );

  bus.registerEventSource('onDidChangeTextEditorSelection', (emit) =>
    vscode.window.onDidChangeTextEditorSelection((e) => {
      emit({
        textEditor: serializer.textEditor(e.textEditor),
        selections: e.selections.map((s) => serializer.selection(s)!),
        kind: e.kind,
      });
    }),
  );

  bus.registerEventSource('onDidChangeTextEditorVisibleRanges', (emit) =>
    vscode.window.onDidChangeTextEditorVisibleRanges((e) => {
      emit({
        textEditor: serializer.textEditor(e.textEditor),
        visibleRanges: e.visibleRanges.map((r) => serializer.range(r)!),
      });
    }),
  );

  bus.registerEventSource('onDidOpenTextDocument', (emit) =>
    vscode.workspace.onDidOpenTextDocument((d) => emit(serializer.textDocumentMeta(d))),
  );

  bus.registerEventSource('onDidCloseTextDocument', (emit) =>
    vscode.workspace.onDidCloseTextDocument((d) => emit(serializer.textDocumentMeta(d))),
  );

  bus.registerEventSource('onDidSaveTextDocument', (emit) =>
    vscode.workspace.onDidSaveTextDocument((d) => emit(serializer.textDocumentMeta(d))),
  );

  bus.registerEventSource('onDidChangeTextDocument', (emit) =>
    vscode.workspace.onDidChangeTextDocument((e) => {
      emit({
        document: serializer.textDocumentMeta(e.document),
        contentChanges: e.contentChanges.map((c) => ({
          range: serializer.range(c.range)!,
          rangeOffset: c.rangeOffset,
          rangeLength: c.rangeLength,
          text: c.text,
        })),
        reason: e.reason,
      });
    }),
  );

  bus.registerEventSource('onDidChangeWorkspaceFolders', (emit) =>
    vscode.workspace.onDidChangeWorkspaceFolders((e) => {
      emit({
        added: e.added.map((f) => serializer.workspaceFolder(f)),
        removed: e.removed.map((f) => serializer.workspaceFolder(f)),
      });
    }),
  );

  bus.registerEventSource('onDidChangeConfiguration', (emit) =>
    vscode.workspace.onDidChangeConfiguration((e) => {
      // The event object exposes affectsConfiguration; we can't enumerate changed keys directly,
      // so we just signal that *something* changed. Clients re-fetch what they care about.
      emit({ changed: true, ts: Date.now(), affectsConfiguration: undefined });
      void e;
    }),
  );

  bus.registerEventSource('onDidChangeWindowState', (emit) =>
    vscode.window.onDidChangeWindowState((s) => emit({ focused: s.focused, active: s.active })),
  );

  bus.registerEventSource('onDidChangeVisibleTextEditors', (emit) =>
    vscode.window.onDidChangeVisibleTextEditors((editors) => emit(editors.map((e) => serializer.textEditor(e)))),
  );

  bus.registerEventSource('onDidStartDebugSession', (emit) =>
    vscode.debug.onDidStartDebugSession((s) => emit({ id: s.id, name: s.name, type: s.type })),
  );

  bus.registerEventSource('onDidTerminateDebugSession', (emit) =>
    vscode.debug.onDidTerminateDebugSession((s) => emit({ id: s.id, name: s.name, type: s.type })),
  );

  bus.registerEventSource('onDidChangeBreakpoints', (emit) =>
    vscode.debug.onDidChangeBreakpoints((e) => emit({
      added: e.added.length,
      removed: e.removed.length,
      changed: e.changed.length,
    })),
  );

  bus.registerEventSource('onDidOpenTerminal', (emit) =>
    vscode.window.onDidOpenTerminal((t) => emit({ name: t.name, processId: undefined })),
  );

  bus.registerEventSource('onDidCloseTerminal', (emit) =>
    vscode.window.onDidCloseTerminal((t) => emit({ name: t.name, exitCode: t.exitStatus?.code ?? null })),
  );

  bus.registerEventSource('onDidStartTask', (emit) =>
    vscode.tasks.onDidStartTask((e) => emit({ name: e.execution.task.name, source: e.execution.task.source })),
  );

  bus.registerEventSource('onDidEndTask', (emit) =>
    vscode.tasks.onDidEndTask((e) => emit({ name: e.execution.task.name, source: e.execution.task.source })),
  );

  bus.registerEventSource('onDidEndTaskProcess', (emit) =>
    vscode.tasks.onDidEndTaskProcess((e) => emit({
      name: e.execution.task.name,
      exitCode: e.exitCode ?? null,
    })),
  );

  // Diagnostics — biggest dev-cycle gap before this. The event carries only the affected URIs,
  // so we emit those and clients can call POST /languages/diagnostics {uri} to read details.
  bus.registerEventSource('onDidChangeDiagnostics', (emit) =>
    vscode.languages.onDidChangeDiagnostics((e) => {
      emit({ uris: e.uris.map((u) => serializer.uri(u)!) });
    }),
  );

  // Tab groups / tabs — richer than editor events, includes diff/custom/webview/notebook/terminal tabs.
  bus.registerEventSource('onDidChangeTabs', (emit) =>
    vscode.window.tabGroups.onDidChangeTabs((e) => {
      emit({
        opened: e.opened.map((t) => ({ label: t.label, isActive: t.isActive })),
        closed: e.closed.map((t) => ({ label: t.label })),
        changed: e.changed.map((t) => ({ label: t.label, isActive: t.isActive, isDirty: t.isDirty, isPinned: t.isPinned })),
      });
    }),
  );

  bus.registerEventSource('onDidChangeTabGroups', (emit) =>
    vscode.window.tabGroups.onDidChangeTabGroups((e) => {
      emit({
        opened: e.opened.map((g) => ({ viewColumn: g.viewColumn, isActive: g.isActive })),
        closed: e.closed.map((g) => ({ viewColumn: g.viewColumn })),
        changed: e.changed.map((g) => ({ viewColumn: g.viewColumn, isActive: g.isActive, activeTabLabel: g.activeTab?.label ?? null })),
      });
    }),
  );

  // Terminal active state + theme.
  bus.registerEventSource('onDidChangeActiveTerminal', (emit) =>
    vscode.window.onDidChangeActiveTerminal((t) => emit(t ? { name: t.name } : null)),
  );

  bus.registerEventSource('onDidChangeActiveColorTheme', (emit) =>
    vscode.window.onDidChangeActiveColorTheme((t) => emit({ kind: t.kind })),
  );

  // File lifecycle — fires after the FS operation succeeds. (For pre-commit-style hooks use
  // workspace.onWillCreate/Delete/RenameFiles — not exposed because they're synchronous and
  // can't easily wait on an async HTTP roundtrip.)
  bus.registerEventSource('onDidCreateFiles', (emit) =>
    vscode.workspace.onDidCreateFiles((e) => emit({ files: e.files.map((u) => serializer.uri(u)!) })),
  );

  bus.registerEventSource('onDidDeleteFiles', (emit) =>
    vscode.workspace.onDidDeleteFiles((e) => emit({ files: e.files.map((u) => serializer.uri(u)!) })),
  );

  bus.registerEventSource('onDidRenameFiles', (emit) =>
    vscode.workspace.onDidRenameFiles((e) => emit({
      files: e.files.map((f) => ({ oldUri: serializer.uri(f.oldUri)!, newUri: serializer.uri(f.newUri)! })),
    })),
  );

  // Debug — active session changes (start/terminate are already covered above).
  bus.registerEventSource('onDidChangeActiveDebugSession', (emit) =>
    vscode.debug.onDidChangeActiveDebugSession((s) =>
      emit(s ? { id: s.id, name: s.name, type: s.type } : null),
    ),
  );

  // Notebooks.
  bus.registerEventSource('onDidOpenNotebookDocument', (emit) =>
    vscode.workspace.onDidOpenNotebookDocument((d) => emit({
      uri: serializer.uri(d.uri)!,
      notebookType: d.notebookType,
      cellCount: d.cellCount,
    })),
  );

  bus.registerEventSource('onDidCloseNotebookDocument', (emit) =>
    vscode.workspace.onDidCloseNotebookDocument((d) => emit({
      uri: serializer.uri(d.uri)!,
      notebookType: d.notebookType,
    })),
  );

  bus.registerEventSource('onDidChangeNotebookDocument', (emit) =>
    vscode.workspace.onDidChangeNotebookDocument((e) => emit({
      uri: serializer.uri(e.notebook.uri)!,
      contentChanges: e.contentChanges.length,
      cellChanges: e.cellChanges.length,
    })),
  );

  // Extensions list (install/uninstall/enable/disable).
  bus.registerEventSource('onDidChangeExtensions', (emit) =>
    vscode.extensions.onDidChange(() => emit({ count: vscode.extensions.all.length, ts: Date.now() })),
  );

  // Language Model API — new models available, consent granted/revoked, etc.
  bus.registerEventSource('onDidChangeChatModels', (emit) =>
    vscode.lm.onDidChangeChatModels(() => emit({ ts: Date.now() })),
  );
}

export function writeSseHeaders(res: Response): void {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  // Push initial comment to flush headers immediately.
  res.write(': connected\n\n');
}

export function writeSseEvent(res: Response, eventName: string, payload: unknown): void {
  res.write(`event: ${eventName}\n`);
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}
