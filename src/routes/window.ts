import * as vscode from 'vscode';
import type { EndpointRegistry } from '../registry';
import type { Serializer } from '../serializer';

const outputChannels = new Map<string, vscode.OutputChannel>();

function toSnippetLocation(
  input: unknown,
  serializer: Serializer,
): vscode.Position | vscode.Range | vscode.Position[] | vscode.Range[] {
  if (Array.isArray(input)) {
    if (input.length === 0) throw new TypeError('location: empty array');
    const first = input[0] as { start?: unknown };
    if (first && typeof first === 'object' && 'start' in first) {
      return input.map((i) => serializer.toRange(i));
    }
    return input.map((i) => serializer.toPosition(i));
  }
  if (input && typeof input === 'object' && 'start' in (input as { start?: unknown })) {
    return serializer.toRange(input);
  }
  return serializer.toPosition(input);
}

export function registerWindowRoutes(registry: EndpointRegistry, owner: string): void {
  const reg = (def: Parameters<EndpointRegistry['register']>[0]) =>
    registry.register({ tag: 'window', ...def }, owner);

  // ---- Editor state ----

  reg({
    method: 'GET',
    path: '/window/activeTextEditor',
    summary: 'Currently active editor (file, selections, visible ranges)',
    handler: (_, ctx) => {
      const e = vscode.window.activeTextEditor;
      return e ? ctx.serializer.textEditor(e) : null;
    },
  });

  reg({
    method: 'GET',
    path: '/window/visibleTextEditors',
    summary: 'All visible editors',
    handler: (_, ctx) => vscode.window.visibleTextEditors.map((e) => ctx.serializer.textEditor(e)),
  });

  reg({
    method: 'GET',
    path: '/window/selectionText',
    summary: 'Text content of the active editor\'s current selection (or full doc if no selection).',
    handler: () => {
      const e = vscode.window.activeTextEditor;
      if (!e) return { text: null, hasSelection: false };
      const sel = e.selection;
      if (sel.isEmpty) return { text: e.document.getText(), hasSelection: false };
      return { text: e.document.getText(sel), hasSelection: true };
    },
  });

  reg({
    method: 'POST',
    path: '/window/showTextDocument',
    summary: 'Open a document in the editor and focus it',
    params: {
      type: 'object',
      properties: {
        uri: { type: 'string' },
        viewColumn: { type: 'integer', description: 'ViewColumn number (1, 2, 3, …) or -1 for beside' },
        preserveFocus: { type: 'boolean' },
        preview: { type: 'boolean' },
        selection: { type: 'object' },
      },
      required: ['uri'],
    },
    handler: async (raw, ctx) => {
      const p = raw as { uri: string; viewColumn?: number; preserveFocus?: boolean; preview?: boolean; selection?: unknown };
      const doc = await vscode.workspace.openTextDocument(ctx.serializer.toUri(p.uri));
      const editor = await vscode.window.showTextDocument(doc, {
        viewColumn: p.viewColumn as vscode.ViewColumn | undefined,
        preserveFocus: p.preserveFocus,
        preview: p.preview,
        selection: p.selection ? ctx.serializer.toRange(p.selection) : undefined,
      });
      return ctx.serializer.textEditor(editor);
    },
  });

  reg({
    method: 'POST',
    path: '/window/setSelection',
    summary: 'Set the active editor\'s selection(s)',
    params: {
      type: 'object',
      properties: {
        selections: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              anchor: { type: 'object' },
              active: { type: 'object' },
            },
            required: ['anchor', 'active'],
          },
        },
      },
      required: ['selections'],
    },
    handler: (raw, ctx) => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) throw new Error('No active editor');
      const p = raw as { selections: Array<{ anchor: unknown; active: unknown }> };
      editor.selections = p.selections.map((s) => new vscode.Selection(
        ctx.serializer.toPosition(s.anchor),
        ctx.serializer.toPosition(s.active),
      ));
      return ctx.serializer.textEditor(editor);
    },
  });

  reg({
    method: 'POST',
    path: '/window/revealRange',
    summary: 'Scroll the active editor to reveal a range',
    params: {
      type: 'object',
      properties: {
        range: { type: 'object' },
        revealType: { type: 'string', enum: ['Default', 'InCenter', 'InCenterIfOutsideViewport', 'AtTop'] },
      },
      required: ['range'],
    },
    handler: (raw, ctx) => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) throw new Error('No active editor');
      const p = raw as { range: unknown; revealType?: keyof typeof vscode.TextEditorRevealType };
      const type = p.revealType ? vscode.TextEditorRevealType[p.revealType] : vscode.TextEditorRevealType.Default;
      editor.revealRange(ctx.serializer.toRange(p.range), type);
      return { ok: true };
    },
  });

  reg({
    method: 'POST',
    path: '/window/insertSnippet',
    summary: 'Insert a SnippetString into an editor with tab stops, placeholders, and choices',
    description:
      'Wraps TextEditor.insertSnippet — the only way to insert text with $1/$2 tab stops, ' +
      '${1:default} placeholders, ${1|a,b,c|} choice lists, and the $0 final stop. Use this ' +
      'when an agent wants to scaffold code but leave specific values for the user to fill in ' +
      '(parameter names, error messages, assertion bodies, ambiguous picks). For inserts with ' +
      'no tab stops, use /workspace/applyEdit instead.\n\n' +
      'Targets the active editor by default; pass uri to target a specific visible editor instead. ' +
      'Without location, the snippet replaces current selection(s). location accepts a Position ' +
      '({line,character}), a Range ({start,end}), or an array of either for multi-cursor insertion.\n\n' +
      'Persistent named snippets (Pattern B — define once, reuse via IntelliSense):\n' +
      '  1. Define: write a JSON file via /workspace/fs/writeFile to one of:\n' +
      '       <workspace>/.vscode/<anything>.code-snippets   (workspace-scoped; supports any languages via "scope")\n' +
      '       <user-snippets-dir>/<langId>.json              (user-global, per language)\n' +
      '       <user-snippets-dir>/<anything>.code-snippets   (user-global, multi-language via "scope")\n' +
      '     Schema example:\n' +
      '       {\n' +
      '         "log error": {\n' +
      '           "scope": "javascript,typescript",\n' +
      '           "prefix": "logerr",\n' +
      '           "body": ["console.error(\\"${1:msg}\\", ${2:err});", "$0"],\n' +
      '           "description": "Log an error"\n' +
      '         }\n' +
      '       }\n' +
      '  2. Trigger: either user types the prefix + Tab, or call /commands/execute with command\n' +
      '     "editor.action.insertSnippet" and args { name: "log error" } (workspace snippet name) or\n' +
      '     { langId: "typescript", name: "log error" }. You can also pass { snippet: "..." } to that\n' +
      '     command for an ad-hoc insert without an editor reference — equivalent to this endpoint.',
    params: {
      type: 'object',
      properties: {
        snippet: {
          type: 'string',
          description: 'Snippet body. Example: "function ${1:name}(${2:arg}) {\\n\\t$0\\n}"',
        },
        uri: {
          type: 'string',
          description: 'Optional target editor URI. Must be currently visible. Defaults to active editor.',
        },
        location: {
          description:
            'Optional. Position {line,character}, Range {start,end}, or array of either. ' +
            'Defaults to the editor\'s current selection(s).',
        },
        undoStopBefore: { type: 'boolean', description: 'Default true' },
        undoStopAfter: { type: 'boolean', description: 'Default true' },
      },
      required: ['snippet'],
    },
    handler: async (raw, ctx) => {
      const p = raw as {
        snippet: string;
        uri?: string;
        location?: unknown;
        undoStopBefore?: boolean;
        undoStopAfter?: boolean;
      };

      const editor = p.uri
        ? vscode.window.visibleTextEditors.find(
            (e) => e.document.uri.toString() === ctx.serializer.toUri(p.uri!).toString(),
          )
        : vscode.window.activeTextEditor;
      if (!editor) {
        throw new Error(
          p.uri
            ? `No visible editor for uri: ${p.uri}. Open it first via /window/showTextDocument.`
            : 'No active editor',
        );
      }

      const location = p.location !== undefined ? toSnippetLocation(p.location, ctx.serializer) : undefined;
      const options = (p.undoStopBefore !== undefined || p.undoStopAfter !== undefined)
        ? { undoStopBefore: p.undoStopBefore ?? true, undoStopAfter: p.undoStopAfter ?? true }
        : undefined;

      const ok = await editor.insertSnippet(new vscode.SnippetString(p.snippet), location, options);
      return { ok };
    },
  });

  // ---- Notifications & prompts ----

  reg({
    method: 'POST',
    path: '/window/showInformationMessage',
    summary: 'Show an info notification; returns the selected item (or null)',
    params: {
      type: 'object',
      properties: {
        message: { type: 'string' },
        items: { type: 'array', items: { type: 'string' } },
        modal: { type: 'boolean' },
      },
      required: ['message'],
    },
    handler: async (raw) => {
      const p = raw as { message: string; items?: string[]; modal?: boolean };
      const pick = p.items && p.items.length > 0
        ? await vscode.window.showInformationMessage(p.message, { modal: p.modal }, ...p.items)
        : await vscode.window.showInformationMessage(p.message, { modal: p.modal });
      return { selected: pick ?? null };
    },
  });

  reg({
    method: 'POST',
    path: '/window/showWarningMessage',
    summary: 'Show a warning notification',
    params: {
      type: 'object',
      properties: { message: { type: 'string' }, items: { type: 'array', items: { type: 'string' } }, modal: { type: 'boolean' } },
      required: ['message'],
    },
    handler: async (raw) => {
      const p = raw as { message: string; items?: string[]; modal?: boolean };
      const pick = p.items && p.items.length > 0
        ? await vscode.window.showWarningMessage(p.message, { modal: p.modal }, ...p.items)
        : await vscode.window.showWarningMessage(p.message, { modal: p.modal });
      return { selected: pick ?? null };
    },
  });

  reg({
    method: 'POST',
    path: '/window/showErrorMessage',
    summary: 'Show an error notification',
    params: {
      type: 'object',
      properties: { message: { type: 'string' }, items: { type: 'array', items: { type: 'string' } }, modal: { type: 'boolean' } },
      required: ['message'],
    },
    handler: async (raw) => {
      const p = raw as { message: string; items?: string[]; modal?: boolean };
      const pick = p.items && p.items.length > 0
        ? await vscode.window.showErrorMessage(p.message, { modal: p.modal }, ...p.items)
        : await vscode.window.showErrorMessage(p.message, { modal: p.modal });
      return { selected: pick ?? null };
    },
  });

  reg({
    method: 'POST',
    path: '/window/showQuickPick',
    summary: 'Show a quick pick; returns selected item(s)',
    params: {
      type: 'object',
      properties: {
        items: { type: 'array', items: { type: 'string' } },
        canPickMany: { type: 'boolean' },
        placeHolder: { type: 'string' },
        title: { type: 'string' },
      },
      required: ['items'],
    },
    handler: async (raw) => {
      const p = raw as { items: string[]; canPickMany?: boolean; placeHolder?: string; title?: string };
      const result = await vscode.window.showQuickPick(p.items, {
        canPickMany: p.canPickMany,
        placeHolder: p.placeHolder,
        title: p.title,
      });
      return { selected: result ?? null };
    },
  });

  reg({
    method: 'POST',
    path: '/window/showInputBox',
    summary: 'Show an input box; returns the entered string',
    params: {
      type: 'object',
      properties: {
        prompt: { type: 'string' },
        value: { type: 'string' },
        placeHolder: { type: 'string' },
        password: { type: 'boolean' },
        title: { type: 'string' },
      },
    },
    handler: async (raw) => {
      const p = raw as { prompt?: string; value?: string; placeHolder?: string; password?: boolean; title?: string };
      const result = await vscode.window.showInputBox({
        prompt: p.prompt,
        value: p.value,
        placeHolder: p.placeHolder,
        password: p.password,
        title: p.title,
      });
      return { value: result ?? null };
    },
  });

  // ---- Window state ----

  reg({
    method: 'GET',
    path: '/window/state',
    summary: 'Window focus / active state',
    handler: () => ({ focused: vscode.window.state.focused, active: vscode.window.state.active }),
  });

  reg({
    method: 'GET',
    path: '/window/activeColorTheme',
    summary: 'Active color theme metadata',
    handler: () => ({ kind: vscode.window.activeColorTheme.kind }),
  });

  // ---- Terminals ----

  reg({
    method: 'GET',
    path: '/window/terminals',
    summary: 'List open terminals',
    handler: () => vscode.window.terminals.map((t) => ({
      name: t.name,
      processId: undefined,
      exitStatus: t.exitStatus ? { code: t.exitStatus.code ?? null } : null,
    })),
  });

  reg({
    method: 'POST',
    path: '/window/createTerminal',
    summary: 'Create a new terminal',
    params: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        cwd: { type: 'string' },
        shellPath: { type: 'string' },
        shellArgs: { type: 'array', items: { type: 'string' } },
        show: { type: 'boolean' },
      },
    },
    handler: (raw) => {
      const p = raw as { name?: string; cwd?: string; shellPath?: string; shellArgs?: string[]; show?: boolean };
      const term = vscode.window.createTerminal({
        name: p.name,
        cwd: p.cwd,
        shellPath: p.shellPath,
        shellArgs: p.shellArgs,
      });
      if (p.show !== false) term.show();
      return { name: term.name };
    },
  });

  reg({
    method: 'POST',
    path: '/window/terminalSendText',
    summary: 'Send text to a terminal by name (or active terminal)',
    params: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Terminal name; defaults to active terminal' },
        text: { type: 'string' },
        addNewLine: { type: 'boolean', description: 'Default true' },
      },
      required: ['text'],
    },
    handler: (raw) => {
      const p = raw as { name?: string; text: string; addNewLine?: boolean };
      const term = p.name
        ? vscode.window.terminals.find((t) => t.name === p.name)
        : vscode.window.activeTerminal;
      if (!term) throw new Error('Terminal not found (provide name or focus a terminal first)');
      term.sendText(p.text, p.addNewLine ?? true);
      return { ok: true, name: term.name };
    },
  });

  reg({
    method: 'POST',
    path: '/window/terminalShow',
    summary: 'Show a terminal by name',
    params: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
    handler: (raw) => {
      const p = raw as { name: string };
      const term = vscode.window.terminals.find((t) => t.name === p.name);
      if (!term) throw new Error(`Terminal not found: ${p.name}`);
      term.show();
      return { ok: true };
    },
  });

  reg({
    method: 'POST',
    path: '/window/terminalDispose',
    summary: 'Dispose (close) a terminal by name',
    params: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
    handler: (raw) => {
      const p = raw as { name: string };
      const term = vscode.window.terminals.find((t) => t.name === p.name);
      if (!term) throw new Error(`Terminal not found: ${p.name}`);
      term.dispose();
      return { ok: true };
    },
  });

  // ---- Status bar ----

  reg({
    method: 'POST',
    path: '/window/setStatusBarMessage',
    summary: 'Show a transient status bar message',
    params: {
      type: 'object',
      properties: { text: { type: 'string' }, hideAfterMs: { type: 'integer' } },
      required: ['text'],
    },
    handler: (raw) => {
      const p = raw as { text: string; hideAfterMs?: number };
      if (p.hideAfterMs !== undefined) {
        vscode.window.setStatusBarMessage(p.text, p.hideAfterMs);
      } else {
        vscode.window.setStatusBarMessage(p.text);
      }
      return { ok: true };
    },
  });

  // ---- File dialogs ----

  reg({
    method: 'POST',
    path: '/window/showOpenDialog',
    summary: 'Native open-file/folder dialog; returns selected URIs',
    params: {
      type: 'object',
      properties: {
        defaultUri: { type: 'string' },
        canSelectFiles: { type: 'boolean' },
        canSelectFolders: { type: 'boolean' },
        canSelectMany: { type: 'boolean' },
        openLabel: { type: 'string' },
        title: { type: 'string' },
        filters: {
          type: 'object',
          additionalProperties: { type: 'array', items: { type: 'string' } },
          description: 'e.g. { "TypeScript": ["ts","tsx"], "All": ["*"] }',
        },
      },
    },
    handler: async (raw, ctx) => {
      const p = raw as {
        defaultUri?: string; canSelectFiles?: boolean; canSelectFolders?: boolean;
        canSelectMany?: boolean; openLabel?: string; title?: string; filters?: Record<string, string[]>;
      };
      const result = await vscode.window.showOpenDialog({
        defaultUri: p.defaultUri ? ctx.serializer.toUri(p.defaultUri) : undefined,
        canSelectFiles: p.canSelectFiles,
        canSelectFolders: p.canSelectFolders,
        canSelectMany: p.canSelectMany,
        openLabel: p.openLabel,
        title: p.title,
        filters: p.filters,
      });
      return { uris: (result ?? []).map((u) => ctx.serializer.uri(u)) };
    },
  });

  reg({
    method: 'POST',
    path: '/window/showSaveDialog',
    summary: 'Native save-file dialog; returns selected URI',
    params: {
      type: 'object',
      properties: {
        defaultUri: { type: 'string' },
        saveLabel: { type: 'string' },
        title: { type: 'string' },
        filters: {
          type: 'object',
          additionalProperties: { type: 'array', items: { type: 'string' } },
        },
      },
    },
    handler: async (raw, ctx) => {
      const p = raw as { defaultUri?: string; saveLabel?: string; title?: string; filters?: Record<string, string[]> };
      const result = await vscode.window.showSaveDialog({
        defaultUri: p.defaultUri ? ctx.serializer.toUri(p.defaultUri) : undefined,
        saveLabel: p.saveLabel,
        title: p.title,
        filters: p.filters,
      });
      return { uri: result ? ctx.serializer.uri(result) : null };
    },
  });

  reg({
    method: 'POST',
    path: '/window/showWorkspaceFolderPick',
    summary: 'Prompt the user to pick a workspace folder',
    params: {
      type: 'object',
      properties: { placeHolder: { type: 'string' }, ignoreFocusOut: { type: 'boolean' } },
    },
    handler: async (raw, ctx) => {
      const p = raw as { placeHolder?: string; ignoreFocusOut?: boolean };
      const folder = await vscode.window.showWorkspaceFolderPick({
        placeHolder: p.placeHolder,
        ignoreFocusOut: p.ignoreFocusOut,
      });
      return folder ? ctx.serializer.workspaceFolder(folder) : null;
    },
  });

  // ---- Output channels ----

  reg({
    method: 'GET',
    path: '/window/outputChannels',
    summary: 'List output channels created through this API',
    description:
      'Lists channels created via /window/outputChannel/create. Built-in or extension-owned channels ' +
      "aren't enumerable through the public API, so they don't appear here.",
    handler: () => ({ channels: Array.from(outputChannels.keys()) }),
  });

  reg({
    method: 'POST',
    path: '/window/outputChannel/create',
    summary: 'Create or fetch a named output channel',
    params: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        languageId: { type: 'string', description: 'Optional language id for syntax highlighting' },
      },
      required: ['name'],
    },
    handler: (raw) => {
      const p = raw as { name: string; languageId?: string };
      if (!outputChannels.has(p.name)) {
        const ch = p.languageId
          ? vscode.window.createOutputChannel(p.name, p.languageId)
          : vscode.window.createOutputChannel(p.name);
        outputChannels.set(p.name, ch);
      }
      return { name: p.name, created: true };
    },
  });

  reg({
    method: 'POST',
    path: '/window/outputChannel/append',
    summary: 'Append text to a named output channel (creates the channel on demand)',
    params: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        text: { type: 'string' },
        newline: { type: 'boolean', description: 'Default true — uses appendLine' },
        show: { type: 'boolean', description: 'Reveal the panel after writing' },
        preserveFocus: { type: 'boolean' },
      },
      required: ['name', 'text'],
    },
    handler: (raw) => {
      const p = raw as { name: string; text: string; newline?: boolean; show?: boolean; preserveFocus?: boolean };
      let ch = outputChannels.get(p.name);
      if (!ch) {
        ch = vscode.window.createOutputChannel(p.name);
        outputChannels.set(p.name, ch);
      }
      if (p.newline === false) ch.append(p.text);
      else ch.appendLine(p.text);
      if (p.show) ch.show(p.preserveFocus);
      return { ok: true };
    },
  });

  reg({
    method: 'POST',
    path: '/window/outputChannel/show',
    summary: 'Reveal an output channel panel',
    params: {
      type: 'object',
      properties: { name: { type: 'string' }, preserveFocus: { type: 'boolean' } },
      required: ['name'],
    },
    handler: (raw) => {
      const p = raw as { name: string; preserveFocus?: boolean };
      const ch = outputChannels.get(p.name);
      if (!ch) throw new Error(`Output channel not found: ${p.name}`);
      ch.show(p.preserveFocus);
      return { ok: true };
    },
  });

  reg({
    method: 'POST',
    path: '/window/outputChannel/clear',
    summary: 'Clear a named output channel',
    params: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
    handler: (raw) => {
      const p = raw as { name: string };
      const ch = outputChannels.get(p.name);
      if (!ch) throw new Error(`Output channel not found: ${p.name}`);
      ch.clear();
      return { ok: true };
    },
  });

  reg({
    method: 'POST',
    path: '/window/outputChannel/dispose',
    summary: 'Dispose (delete) a named output channel',
    params: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
    handler: (raw) => {
      const p = raw as { name: string };
      const ch = outputChannels.get(p.name);
      if (!ch) return { ok: false, message: 'Channel not found' };
      ch.dispose();
      outputChannels.delete(p.name);
      return { ok: true };
    },
  });
}
