import * as vscode from 'vscode';
import { writeSseEvent, writeSseHeaders } from '../events';
import type { EndpointRegistry } from '../registry';

/**
 * Language Model API routes.
 *
 * Wraps `vscode.lm.*` (public since VSCode 1.90) so external callers can use any chat model
 * the user has access to — Copilot (gpt-4o, gpt-4.1, claude-sonnet, o1, ...), and other
 * providers exposed via the LM API — through the same bearer-token gate as everything else.
 *
 * The first call from `vscode-internals` triggers VSCode's consent prompt
 * ("Allow vscode-internals to use language models?"). Subsequent calls are remembered.
 * If consent is denied we surface a `LanguageModelError.NoPermissions` shaped error.
 *
 * Streaming responses go through SSE (`/lm/sendRequestStream`); non-streaming
 * collects the stream and returns the joined text plus token usage when available.
 */
export function registerLmRoutes(registry: EndpointRegistry, owner: string): void {
  const reg = (def: Parameters<EndpointRegistry['register']>[0]) =>
    registry.register({ tag: 'lm', ...def }, owner);

  reg({
    method: 'GET',
    path: '/lm/models',
    summary: 'List all chat models currently available to this VSCode',
    description:
      'Returns every model `vscode.lm.selectChatModels()` reveals with an empty selector. ' +
      'Triggers the model consent prompt on first call if not already granted. ' +
      'Each model includes id, vendor, family, version, name, and maxInputTokens for prompt sizing.',
    handler: async () => {
      const models = await vscode.lm.selectChatModels();
      return { models: models.map(describeModel) };
    },
  });

  reg({
    method: 'POST',
    path: '/lm/selectChatModels',
    summary: 'Filter chat models by vendor / family / version / id',
    description:
      'Thin wrapper around `vscode.lm.selectChatModels(selector)`. Use to narrow to a specific ' +
      'model (e.g. `{vendor: "copilot", family: "gpt-4o"}`) before calling sendRequest.',
    params: {
      type: 'object',
      properties: {
        vendor: { type: 'string', description: 'e.g. "copilot"' },
        family: { type: 'string', description: 'e.g. "gpt-4o", "claude-3.5-sonnet"' },
        version: { type: 'string' },
        id: { type: 'string' },
      },
    },
    handler: async (raw) => {
      const selector = raw as vscode.LanguageModelChatSelector;
      const models = await vscode.lm.selectChatModels(selector);
      return { models: models.map(describeModel) };
    },
  });

  reg({
    method: 'POST',
    path: '/lm/sendRequest',
    summary: 'Send a chat request and collect the full response (non-streaming)',
    description:
      'Calls `model.sendRequest(messages)` and concatenates every text part of the stream into ' +
      'one string before returning. Use this when you do not need partial chunks. For streaming, ' +
      'use POST /lm/sendRequestStream (SSE).',
    params: {
      type: 'object',
      properties: {
        selector: { type: 'object', description: 'Model selector (vendor/family/version/id). If omitted, the first available model is used.' },
        messages: {
          type: 'array',
          description: 'Chat history. Each message has `role` (user|assistant) and `content` (string).',
          items: {
            type: 'object',
            properties: {
              role: { type: 'string', enum: ['user', 'assistant'] },
              content: { type: 'string' },
            },
            required: ['role', 'content'],
          },
        },
        modelOptions: {
          type: 'object',
          description: 'Pass-through to LanguageModelChatRequestOptions.modelOptions (model-specific; e.g. {temperature: 0.2}).',
        },
        justification: { type: 'string', description: 'Shown to the user in the consent prompt if not yet granted.' },
      },
      required: ['messages'],
    },
    handler: async (raw) => {
      const p = raw as SendRequestParams;
      const model = await pickModel(p.selector);
      const messages = toChatMessages(p.messages);
      const options: vscode.LanguageModelChatRequestOptions = {
        justification: p.justification,
        modelOptions: p.modelOptions,
      };
      const response = await model.sendRequest(messages, options);
      let text = '';
      for await (const chunk of response.text) text += chunk;
      return {
        model: describeModel(model),
        text,
      };
    },
  });

  reg({
    method: 'POST',
    path: '/lm/sendRequestStream',
    summary: 'Send a chat request and stream the response as SSE',
    description:
      "Streams the model's response chunks as Server-Sent Events. Emits `event: chunk` (data: {text}) " +
      'for each text part, `event: done` ({totalText}) when the stream ends, and `event: error` on ' +
      'failures (including consent denial). The HTTP connection stays open until the stream completes ' +
      'or the client disconnects.',
    params: {
      type: 'object',
      properties: {
        selector: { type: 'object' },
        messages: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              role: { type: 'string', enum: ['user', 'assistant'] },
              content: { type: 'string' },
            },
            required: ['role', 'content'],
          },
        },
        modelOptions: { type: 'object' },
        justification: { type: 'string' },
      },
      required: ['messages'],
    },
    handler: async (raw, ctx) => {
      const p = raw as SendRequestParams;
      const res = ctx.req.res;
      if (!res) throw new Error('No response object available for streaming');

      // Start SSE early so the client sees the connection open even before model selection.
      writeSseHeaders(res);
      const abortController = new AbortController();
      ctx.req.on('close', () => abortController.abort());

      let totalText = '';
      try {
        const model = await pickModel(p.selector);
        writeSseEvent(res, 'model', describeModel(model));
        const messages = toChatMessages(p.messages);
        const options: vscode.LanguageModelChatRequestOptions = {
          justification: p.justification,
          modelOptions: p.modelOptions,
        };
        const tokenSource = new vscode.CancellationTokenSource();
        abortController.signal.addEventListener('abort', () => tokenSource.cancel());

        const response = await model.sendRequest(messages, options, tokenSource.token);
        for await (const chunk of response.text) {
          if (abortController.signal.aborted) break;
          totalText += chunk;
          writeSseEvent(res, 'chunk', { text: chunk });
        }
        writeSseEvent(res, 'done', { totalText, totalChars: totalText.length });
      } catch (err) {
        const e = err as Error & { code?: string };
        writeSseEvent(res, 'error', {
          message: e.message,
          code: e.code,
          name: e.name,
        });
      } finally {
        res.end();
      }
      // Returning undefined and res.end()'ing ourselves — the dispatcher sees headersSent=true and skips.
      return undefined;
    },
  });

  reg({
    method: 'POST',
    path: '/lm/countTokens',
    summary: 'Count how many tokens a string occupies for a given model',
    description:
      'Calls `model.countTokens(text)`. Use this before sendRequest to fit prompts under the ' +
      "model's `maxInputTokens` limit.",
    params: {
      type: 'object',
      properties: {
        selector: { type: 'object' },
        text: { type: 'string' },
      },
      required: ['text'],
    },
    handler: async (raw) => {
      const p = raw as { selector?: vscode.LanguageModelChatSelector; text: string };
      const model = await pickModel(p.selector);
      const count = await model.countTokens(p.text);
      return { model: describeModel(model), tokens: count };
    },
  });
}

// ---------- helpers ----------

interface SendRequestParams {
  selector?: vscode.LanguageModelChatSelector;
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
  modelOptions?: Record<string, unknown>;
  justification?: string;
}

function describeModel(m: vscode.LanguageModelChat): Record<string, unknown> {
  return {
    id: m.id,
    vendor: m.vendor,
    family: m.family,
    version: m.version,
    name: m.name,
    maxInputTokens: m.maxInputTokens,
  };
}

async function pickModel(selector?: vscode.LanguageModelChatSelector): Promise<vscode.LanguageModelChat> {
  const models = await vscode.lm.selectChatModels(selector);
  if (models.length === 0) {
    const detail = selector ? ` matching selector ${JSON.stringify(selector)}` : '';
    throw new Error(`No language models available${detail}. Is Copilot (or another LM provider) installed and signed in?`);
  }
  return models[0];
}

function toChatMessages(
  msgs: Array<{ role: 'user' | 'assistant'; content: string }>,
): vscode.LanguageModelChatMessage[] {
  return msgs.map((m) => {
    if (m.role === 'assistant') return vscode.LanguageModelChatMessage.Assistant(m.content);
    return vscode.LanguageModelChatMessage.User(m.content);
  });
}
