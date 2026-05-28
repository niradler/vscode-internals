import * as vscode from 'vscode';
import type { EndpointRegistry } from '../registry';

/**
 * Port forwarding / external URI exposure.
 *
 * VSCode's stable port surface is:
 *   - vscode.env.asExternalUri(localUri) — maps localhost:port to a publicly reachable URI in
 *     remote / codespaces / tunnels contexts. In Desktop mode it usually returns the same URI.
 *   - Workbench commands for the Ports panel — used in remote workspaces.
 *
 * We surface both. /ports/forward is the one-call helper most callers want.
 */
export function registerPortsRoutes(registry: EndpointRegistry, owner: string): void {
  const reg = (def: Parameters<EndpointRegistry['register']>[0]) =>
    registry.register({ tag: 'ports', ...def }, owner);

  reg({
    method: 'POST',
    path: '/ports/forward',
    summary: 'Forward a local port and return the externally reachable URI',
    description:
      'Builds a localhost URI for the given port/protocol and asks VSCode to map it to an external URI ' +
      '(via vscode.env.asExternalUri). When running in a remote / codespaces / tunnel context this opens ' +
      'a real forward. In Desktop mode the external URI typically equals the local URI. Also best-effort ' +
      'triggers the Ports panel forward command so the port shows up in the UI.',
    params: {
      type: 'object',
      properties: {
        port: { type: 'integer', minimum: 1, maximum: 65535 },
        protocol: { type: 'string', enum: ['http', 'https'], description: 'Defaults to http' },
        host: { type: 'string', description: 'Defaults to localhost. Use 127.0.0.1 if your service does not bind to localhost.' },
        label: { type: 'string', description: 'Optional label hint (used best-effort)' },
      },
      required: ['port'],
    },
    handler: async (raw) => {
      const p = raw as { port: number; protocol?: 'http' | 'https'; host?: string; label?: string };
      const scheme = p.protocol ?? 'http';
      const host = p.host ?? 'localhost';
      const localUri = vscode.Uri.parse(`${scheme}://${host}:${p.port}`);
      const externalUri = await vscode.env.asExternalUri(localUri);

      let panelForwarded = false;
      try {
        await vscode.commands.executeCommand('remote-explorer.forwardPort', p.port);
        panelForwarded = true;
      } catch {
        // command may not be available outside remote contexts
      }

      return {
        local: localUri.toString(),
        external: externalUri.toString(),
        panelForwarded,
        label: p.label,
      };
    },
  });

  reg({
    method: 'POST',
    path: '/ports/asExternalUri',
    summary: 'Map an arbitrary local URI to its externally reachable form',
    description:
      'Thin wrapper around vscode.env.asExternalUri. Accepts any URI (not just http) and returns the ' +
      'external form. Use this when you already have a fully formed URI; prefer /ports/forward when you ' +
      'just have a port number.',
    params: {
      type: 'object',
      properties: { uri: { type: 'string' } },
      required: ['uri'],
    },
    handler: async (raw) => {
      const p = raw as { uri: string };
      const external = await vscode.env.asExternalUri(vscode.Uri.parse(p.uri));
      return { input: p.uri, external: external.toString() };
    },
  });

  reg({
    method: 'POST',
    path: '/ports/showPanel',
    summary: 'Focus the Ports panel in the workbench',
    description:
      'Reveals the Ports panel where the user can see and manage forwarded ports. Useful after calling ' +
      '/ports/forward so the user can see the forward they just created.',
    handler: async () => {
      // Try the modern container focus command first; fall back to the legacy one.
      const candidates = [
        '~remote.forwardedPortsContainer.focus',
        'workbench.view.remote',
      ];
      for (const cmd of candidates) {
        try {
          await vscode.commands.executeCommand(cmd);
          return { ok: true, command: cmd };
        } catch {
          // try next
        }
      }
      return { ok: false, message: 'No known Ports panel command succeeded in this context' };
    },
  });

  reg({
    method: 'POST',
    path: '/ports/stopForwarding',
    summary: 'Stop forwarding a specific port (best-effort)',
    description:
      'Calls the workbench command to stop forwarding a port. Only meaningful in remote contexts ' +
      'where a real forward exists. Returns { ok: false } if the command is unavailable.',
    params: {
      type: 'object',
      properties: { port: { type: 'integer', minimum: 1, maximum: 65535 } },
      required: ['port'],
    },
    handler: async (raw) => {
      const p = raw as { port: number };
      try {
        await vscode.commands.executeCommand('remote-explorer.stopForwarding', p.port);
        return { ok: true, port: p.port };
      } catch (err) {
        return { ok: false, port: p.port, error: err instanceof Error ? err.message : String(err) };
      }
    },
  });
}
