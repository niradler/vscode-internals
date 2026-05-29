#!/usr/bin/env node
// End-to-end smoke suite for niradler.vscode-internals.
//
// Assumes a running Extension Development Host that has written its
// {url, token} handshake to <tmpdir>/niradler.vscode-internals.dev.json.
// Run via `npm run e2e` after `scripts/launch-host.ps1`.
//
// Exits 0 on full pass, 1 on any failure (suitable for CI / autonomous loops).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HANDSHAKE = path.join(os.tmpdir(), 'niradler.vscode-internals.dev.json');
const STARTUP_TIMEOUT_MS = 30_000;
const REQUEST_TIMEOUT_MS = 10_000;

function readHandshake() {
  if (!fs.existsSync(HANDSHAKE)) {
    throw new Error(
      `Dev handshake file missing at ${HANDSHAKE}.\n` +
        `Launch the extension dev host first (scripts/launch-host.ps1), then re-run.`,
    );
  }
  const raw = JSON.parse(fs.readFileSync(HANDSHAKE, 'utf8'));
  if (!raw.url || !raw.token) throw new Error('Handshake file missing url/token fields.');
  return raw;
}

async function waitForHealth(url, timeoutMs) {
  const started = Date.now();
  let lastErr;
  while (Date.now() - started < timeoutMs) {
    try {
      const r = await fetch(`${url}/health`, { signal: AbortSignal.timeout(2000) });
      if (r.ok) {
        const body = await r.json();
        if (body.ok) return body;
      }
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Server at ${url}/health did not respond OK within ${timeoutMs}ms. Last error: ${lastErr?.message ?? 'none'}`);
}

class TestRun {
  constructor(base, token) {
    this.base = base;
    this.token = token;
    this.results = [];
  }

  async req(method, path, { body, expectStatus = 200, headers = {}, noAuth = false } = {}) {
    const h = { 'Content-Type': 'application/json', ...headers };
    if (!noAuth) h.Authorization = `Bearer ${this.token}`;
    const init = { method, headers: h, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) };
    if (body !== undefined) init.body = JSON.stringify(body);
    const r = await fetch(`${this.base}${path}`, init);
    const text = await r.text();
    let json;
    try { json = text ? JSON.parse(text) : null; } catch { json = text; }
    if (r.status !== expectStatus) {
      throw new Error(`${method} ${path} → ${r.status} (expected ${expectStatus}). Body: ${text.slice(0, 200)}`);
    }
    return json;
  }

  async run(name, fn) {
    const t0 = Date.now();
    try {
      await fn();
      const ms = Date.now() - t0;
      this.results.push({ name, ok: true, ms });
      console.log(`  PASS ${name} (${ms}ms)`);
    } catch (err) {
      const ms = Date.now() - t0;
      this.results.push({ name, ok: false, ms, error: err.message });
      console.log(`  FAIL ${name} (${ms}ms): ${err.message}`);
    }
  }

  summary() {
    const pass = this.results.filter((r) => r.ok).length;
    const fail = this.results.length - pass;
    const totalMs = this.results.reduce((s, r) => s + r.ms, 0);
    return { pass, fail, total: this.results.length, totalMs, results: this.results };
  }
}

async function testSseHeartbeat(base, token) {
  // Subscribe to onDidChangeWindowState — should receive at least the 'ready' event.
  const url = `${base}/events?subscribe=onDidChangeWindowState`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 4000);
  try {
    const r = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
      signal: ctrl.signal,
    });
    if (!r.ok) throw new Error(`SSE handshake failed: ${r.status}`);
    if (!r.headers.get('content-type')?.includes('event-stream')) {
      throw new Error(`Expected event-stream content-type, got ${r.headers.get('content-type')}`);
    }
    const reader = r.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      if (buf.includes('event: ready')) return;
    }
    throw new Error('Did not receive "ready" SSE event within 3s');
  } finally {
    clearTimeout(timer);
    ctrl.abort();
  }
}

async function main() {
  console.log('e2e: reading dev handshake...');
  const { url, token } = readHandshake();
  console.log(`e2e: target ${url}`);

  console.log('e2e: waiting for /health...');
  const health = await waitForHealth(url, STARTUP_TIMEOUT_MS);
  console.log(`e2e: health ok, version=${health.version}`);

  const pkgVersion = JSON.parse(
    fs.readFileSync(path.join(import.meta.dirname, '..', 'package.json'), 'utf8'),
  ).version;
  if (health.version !== pkgVersion) {
    throw new Error(
      `/health version=${health.version} but package.json version=${pkgVersion} — ` +
        `EXTENSION_VERSION drift (see release-notes.md v0.1.2).`,
    );
  }

  const t = new TestRun(url, token);

  // --- Public / auth gate ---
  await t.run('health (no auth)', async () => {
    const r = await t.req('GET', '/health', { noAuth: true });
    if (!r.ok) throw new Error('health.ok != true');
  });

  await t.run('openapi.json (no auth, shape)', async () => {
    const spec = await t.req('GET', '/openapi.json', { noAuth: true });
    if (!String(spec.openapi).startsWith('3.')) {
      throw new Error(`unexpected openapi version: ${spec.openapi}`);
    }
    if (!spec.info?.title || !spec.paths || Object.keys(spec.paths).length === 0) {
      throw new Error('openapi missing info.title or paths');
    }
    // The OpenAPI spec is generated from the dynamic registry only; the unauth public
    // routes (/health, /docs, /openapi.json, /events) are not registered there.
    // Verify a representative registry-backed route appears instead.
    if (!spec.paths['/workspace/folders']) {
      throw new Error('/workspace/folders missing from openapi paths');
    }
  });

  await t.run('docs (no auth, html)', async () => {
    const r = await fetch(`${url}/docs`);
    if (!r.ok) throw new Error(`/docs status ${r.status}`);
    const ct = r.headers.get('content-type') ?? '';
    if (!ct.includes('text/html')) throw new Error(`/docs content-type ${ct}`);
  });

  await t.run('unauthorized request → 401', async () => {
    const r = await fetch(`${url}/workspace/folders`);
    if (r.status !== 401) throw new Error(`expected 401, got ${r.status}`);
  });

  await t.run('invalid token → 401', async () => {
    const r = await fetch(`${url}/workspace/folders`, {
      headers: { Authorization: 'Bearer vscint_bogus' },
    });
    if (r.status !== 401) throw new Error(`expected 401, got ${r.status}`);
  });

  // --- Per-namespace happy path ---
  await t.run('workspace: GET /workspace/folders', async () => {
    const r = await t.req('GET', '/workspace/folders');
    if (!Array.isArray(r)) throw new Error('expected array');
  });

  await t.run('workspace: GET /workspace/name', async () => {
    const r = await t.req('GET', '/workspace/name');
    if (typeof r !== 'object' || r === null) throw new Error('expected object');
    if (!('name' in r && 'rootPath' in r)) throw new Error('missing name/rootPath');
  });

  await t.run('workspace: POST /workspace/findFiles', async () => {
    const r = await t.req('POST', '/workspace/findFiles', { body: { include: '**/package.json', maxResults: 5 } });
    if (!Array.isArray(r)) throw new Error('expected array of URIs');
  });

  await t.run('window: GET /window/state', async () => {
    const r = await t.req('GET', '/window/state');
    if (typeof r?.focused !== 'boolean') throw new Error('missing window.state.focused');
  });

  await t.run('window: GET /window/visibleTextEditors', async () => {
    const r = await t.req('GET', '/window/visibleTextEditors');
    if (!Array.isArray(r)) throw new Error('expected array');
  });

  await t.run('tabs: GET /tabs/list', async () => {
    const r = await t.req('GET', '/tabs/list');
    if (!Array.isArray(r)) throw new Error('expected array');
  });

  await t.run('tabs: GET /tabs/groups', async () => {
    const r = await t.req('GET', '/tabs/groups');
    if (typeof r !== 'object' || r === null) throw new Error('expected object');
    if (!Array.isArray(r.groups)) throw new Error('expected r.groups[] array');
  });

  await t.run('languages: GET /languages/all', async () => {
    const r = await t.req('GET', '/languages/all');
    if (!Array.isArray(r?.languages) || r.languages.length === 0) {
      throw new Error('expected non-empty r.languages[]');
    }
  });

  await t.run('languages: POST /languages/diagnostics (workspace-wide)', async () => {
    const r = await t.req('POST', '/languages/diagnostics', { body: {} });
    if (typeof r !== 'object' || r === null) throw new Error('expected object');
  });

  await t.run('commands: GET /commands/list (filter)', async () => {
    const r = await t.req('GET', '/commands/list?filter=workbench.action.files');
    if (typeof r?.count !== 'number' || !Array.isArray(r.commands)) {
      throw new Error('expected {count, commands[]}');
    }
    if (r.count < 1) throw new Error('expected at least one workbench.action.files command');
  });

  await t.run('debug: GET /debug/activeSession (may be null)', async () => {
    await t.req('GET', '/debug/activeSession');
  });

  await t.run('debug: GET /debug/breakpoints', async () => {
    const r = await t.req('GET', '/debug/breakpoints');
    if (!Array.isArray(r)) throw new Error('expected array');
  });

  await t.run('tasks: GET /tasks/list', async () => {
    const r = await t.req('GET', '/tasks/list');
    if (!Array.isArray(r)) throw new Error('expected array');
  });

  await t.run('tasks: GET /tasks/executions', async () => {
    const r = await t.req('GET', '/tasks/executions');
    if (!Array.isArray(r)) throw new Error('expected array');
  });

  await t.run('scm: GET /scm/git/repositories', async () => {
    const r = await t.req('GET', '/scm/git/repositories');
    // could be { available: false } or an array — both acceptable
    if (r === null) throw new Error('null response');
  });

  await t.run('notebooks: GET /notebooks/open', async () => {
    const r = await t.req('GET', '/notebooks/open');
    if (!Array.isArray(r)) throw new Error('expected array');
  });

  await t.run('env: GET /env/info', async () => {
    const r = await t.req('GET', '/env/info');
    if (!r?.appName) throw new Error('env.info.appName missing');
  });

  await t.run('authentication: GET /authentication/accounts?providerId=github', async () => {
    const r = await t.req('GET', '/authentication/accounts?providerId=github');
    // supported flag tells us whether vscode.authentication.getAccounts is exposed
    if (typeof r?.supported !== 'boolean') throw new Error('expected { supported, accounts }');
  });

  await t.run('extensions: GET /extensions/list', async () => {
    const r = await t.req('GET', '/extensions/list');
    if (!Array.isArray(r) || r.length === 0) throw new Error('expected non-empty extensions list');
    const self = r.find((e) => e.id === 'niradler.vscode-internals');
    if (!self) throw new Error('extension did not see itself in /extensions/list');
  });

  await t.run('lm: GET /lm/models', async () => {
    const r = await t.req('GET', '/lm/models');
    if (!Array.isArray(r?.models)) throw new Error('expected r.models[] array');
  });

  await t.run('events: GET /events/available', async () => {
    const r = await t.req('GET', '/events/available');
    if (!Array.isArray(r?.events) || r.events.length === 0) {
      throw new Error('expected non-empty events list');
    }
  });

  await t.run('events: missing subscribe → 400', async () => {
    await t.req('GET', '/events', { expectStatus: 400 });
  });

  await t.run('events: SSE handshake delivers "ready"', async () => {
    await testSseHeartbeat(url, token);
  });

  await t.run('events: /events/wait timeout path', async () => {
    const t0 = Date.now();
    const r = await t.req('GET', '/events/wait?subscribe=onDidChangeWindowState&timeoutMs=1200');
    const elapsed = Date.now() - t0;
    if (r.timeout !== true) throw new Error(`expected timeout:true, got ${JSON.stringify(r)}`);
    if (elapsed < 1100 || elapsed > 4000) {
      throw new Error(`elapsed ${elapsed}ms outside expected 1100-4000 window`);
    }
  });

  await t.run('events: /events/wait live event via /workspace/applyEdit', async () => {
    const doc = await t.req('POST', '/workspace/openTextDocument', {
      body: { content: 'seed\n', language: 'plaintext' },
    });
    const uri = doc.uri.toString;
    const waitUrl = `${url}/events/wait?subscribe=onDidChangeTextDocument&timeoutMs=8000`;
    const waitPromise = fetch(waitUrl, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    }).then(async (r) => {
      if (!r.ok) throw new Error(`wait status ${r.status}`);
      return r.json();
    });
    await new Promise((r) => setTimeout(r, 250));
    await t.req('POST', '/workspace/applyEdit', {
      body: {
        edits: [{
          uri,
          changes: [{
            range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
            newText: 'XX-',
          }],
        }],
      },
    });
    const evt = await waitPromise;
    if (evt.eventName !== 'onDidChangeTextDocument') {
      throw new Error(`unexpected eventName ${evt.eventName}`);
    }
    const change = evt.payload?.contentChanges?.[0];
    if (change?.text !== 'XX-') throw new Error(`expected inserted text "XX-", got ${JSON.stringify(change)}`);
  });

  await t.run('window: /window/insertSnippet expands tab-stops', async () => {
    const doc = await t.req('POST', '/workspace/openTextDocument', {
      body: { content: '', language: 'plaintext' },
    });
    await t.req('POST', '/window/showTextDocument', { body: { uri: doc.uri.toString } });
    const res = await t.req('POST', '/window/insertSnippet', {
      body: { snippet: 'fn(${1:name}, ${2:arg}) => $0' },
    });
    if (res.ok !== true) throw new Error(`expected ok:true, got ${JSON.stringify(res)}`);
    await t.req('POST', '/window/setSelection', {
      body: { selections: [{ anchor: { line: 0, character: 0 }, active: { line: 0, character: 0 } }] },
    });
    const after = await t.req('GET', '/window/selectionText');
    if (!after.text || !after.text.startsWith('fn(name, arg) =>')) {
      throw new Error(`snippet didn't expand defaults; got: ${JSON.stringify(after.text)}`);
    }
  });

  await t.run('404: unknown route returns structured error', async () => {
    const r = await fetch(`${url}/this-does-not-exist`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (r.status !== 404) throw new Error(`expected 404, got ${r.status}`);
    const j = await r.json();
    if (j.error !== 'not_found') throw new Error(`expected error=not_found, got ${j.error}`);
  });

  const sum = t.summary();
  const outFile = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\//, '')), 'e2e-results.json');
  try {
    fs.writeFileSync(outFile, JSON.stringify(sum, null, 2));
  } catch { /* non-fatal */ }

  console.log('');
  console.log('────────────────────────────────────────');
  console.log(`Results: ${sum.pass}/${sum.total} passed (${sum.totalMs}ms total)`);
  if (sum.fail > 0) {
    console.log('Failures:');
    sum.results.filter((r) => !r.ok).forEach((r) => console.log(`  - ${r.name}: ${r.error}`));
    process.exit(1);
  }
  console.log('All green.');
}

main().catch((err) => {
  console.error('e2e fatal:', err.message);
  process.exit(2);
});
