import * as vscode from 'vscode';
import type { EndpointRegistry } from '../registry';

export function registerEnvRoutes(registry: EndpointRegistry, owner: string): void {
  const reg = (def: Parameters<EndpointRegistry['register']>[0]) =>
    registry.register({ tag: 'env', ...def }, owner);

  reg({
    method: 'GET',
    path: '/env/info',
    summary: 'Editor / environment metadata',
    handler: () => ({
      appName: vscode.env.appName,
      appHost: vscode.env.appHost,
      appRoot: vscode.env.appRoot,
      uriScheme: vscode.env.uriScheme,
      language: vscode.env.language,
      machineId: vscode.env.machineId,
      sessionId: vscode.env.sessionId,
      remoteName: vscode.env.remoteName ?? null,
      shell: vscode.env.shell,
      isTelemetryEnabled: vscode.env.isTelemetryEnabled,
      uiKind: vscode.UIKind[vscode.env.uiKind],
      cursorVersion: (vscode as unknown as { cursorVersion?: string }).cursorVersion ?? null,
    }),
  });

  reg({
    method: 'GET',
    path: '/env/clipboard',
    summary: 'Read clipboard text',
    handler: async () => ({ text: await vscode.env.clipboard.readText() }),
  });

  reg({
    method: 'POST',
    path: '/env/clipboard',
    summary: 'Write clipboard text',
    params: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
    handler: async (raw) => {
      const p = raw as { text: string };
      await vscode.env.clipboard.writeText(p.text);
      return { ok: true };
    },
  });

  reg({
    method: 'POST',
    path: '/env/openExternal',
    summary: 'Open a URL in the OS browser (or app-handled URI)',
    params: { type: 'object', properties: { uri: { type: 'string' } }, required: ['uri'] },
    handler: async (raw) => {
      const p = raw as { uri: string };
      const opened = await vscode.env.openExternal(vscode.Uri.parse(p.uri));
      return { opened };
    },
  });

  reg({
    method: 'POST',
    path: '/env/asExternalUri',
    summary: 'Map a localhost URI to a publicly reachable URI (e.g. through tunnels)',
    params: { type: 'object', properties: { uri: { type: 'string' } }, required: ['uri'] },
    handler: async (raw) => {
      const p = raw as { uri: string };
      const external = await vscode.env.asExternalUri(vscode.Uri.parse(p.uri));
      return { external: external.toString() };
    },
  });

  reg({
    method: 'GET',
    path: '/env/tunnels',
    summary: 'List active tunnels (proposed API; feature-detected)',
    description:
      'Returns the value of vscode.workspace.tunnels (or vscode.env.tunnels in older builds) if the API ' +
      'is available in this VSCode version. Tunnels are only meaningful in remote / codespaces / tunnel ' +
      'contexts. Returns { supported: false } when the API is not present.',
    handler: async () => {
      const ws = vscode.workspace as unknown as { tunnels?: Promise<Array<TunnelLike>> | Array<TunnelLike> };
      const en = vscode.env as unknown as { tunnels?: Promise<Array<TunnelLike>> | Array<TunnelLike> };
      const src = ws.tunnels ?? en.tunnels;
      if (src == null) return { supported: false, message: 'tunnels API not available in this VSCode build' };
      const arr = await Promise.resolve(src);
      return { supported: true, tunnels: arr.map(serializeTunnel) };
    },
  });

  reg({
    method: 'POST',
    path: '/env/openTunnel',
    summary: 'Open a tunnel to a remote port (proposed API; feature-detected)',
    params: {
      type: 'object',
      properties: {
        remoteHost: { type: 'string', description: 'Default 127.0.0.1' },
        remotePort: { type: 'integer' },
        localPort: { type: 'integer', description: 'Optional preferred local port' },
        label: { type: 'string' },
      },
      required: ['remotePort'],
    },
    handler: async (raw) => {
      const p = raw as { remoteHost?: string; remotePort: number; localPort?: number; label?: string };
      const ws = vscode.workspace as unknown as { openTunnel?: (opts: unknown) => Promise<TunnelLike> };
      const en = vscode.env as unknown as { openTunnel?: (opts: unknown) => Promise<TunnelLike> };
      const fn = ws.openTunnel ?? en.openTunnel;
      if (!fn) return { supported: false, message: 'openTunnel API not available in this VSCode build' };
      const tunnel = await fn.call(ws.openTunnel ? vscode.workspace : vscode.env, {
        remoteAddress: { host: p.remoteHost ?? '127.0.0.1', port: p.remotePort },
        localAddressPort: p.localPort,
        label: p.label,
      });
      return { supported: true, tunnel: serializeTunnel(tunnel) };
    },
  });
}

interface TunnelLike {
  remoteAddress?: { host?: string; port?: number };
  localAddress?: string | { host?: string; port?: number };
  public?: boolean;
}

function serializeTunnel(t: TunnelLike): unknown {
  const local = typeof t.localAddress === 'string'
    ? { uri: t.localAddress }
    : { host: t.localAddress?.host, port: t.localAddress?.port };
  return {
    remote: { host: t.remoteAddress?.host, port: t.remoteAddress?.port },
    local,
    public: t.public ?? false,
  };
}
