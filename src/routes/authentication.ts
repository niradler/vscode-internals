import * as vscode from 'vscode';
import type { EndpointRegistry } from '../registry';

export function registerAuthenticationRoutes(registry: EndpointRegistry, owner: string): void {
  const reg = (def: Parameters<EndpointRegistry['register']>[0]) =>
    registry.register({ tag: 'authentication', ...def }, owner);

  reg({
    method: 'POST',
    path: '/authentication/getSession',
    summary: 'Get an auth session (e.g. github, microsoft)',
    description:
      'Retrieves an authentication session from a registered provider. May prompt the user. ' +
      'Returns { id, accessToken, account, scopes } when a session is available.',
    params: {
      type: 'object',
      properties: {
        providerId: { type: 'string', description: 'e.g. "github", "microsoft"' },
        scopes: { type: 'array', items: { type: 'string' } },
        createIfNone: { type: 'boolean' },
        silent: { type: 'boolean' },
        clearSessionPreference: { type: 'boolean' },
      },
      required: ['providerId', 'scopes'],
    },
    handler: async (raw) => {
      const p = raw as {
        providerId: string; scopes: string[];
        createIfNone?: boolean; silent?: boolean; clearSessionPreference?: boolean;
      };
      const session = await vscode.authentication.getSession(p.providerId, p.scopes, {
        createIfNone: p.createIfNone,
        silent: p.silent,
        clearSessionPreference: p.clearSessionPreference,
      });
      if (!session) return null;
      return {
        id: session.id,
        accessToken: session.accessToken,
        account: { id: session.account.id, label: session.account.label },
        scopes: session.scopes,
      };
    },
  });

  reg({
    method: 'GET',
    path: '/authentication/accounts',
    summary: 'List accounts for a provider',
    params: { type: 'object', properties: { providerId: { type: 'string' } }, required: ['providerId'] },
    handler: async (raw) => {
      const p = raw as { providerId: string };
      // vscode.authentication.getAccounts is available in newer API versions; guard for older runtimes.
      const auth = vscode.authentication as unknown as {
        getAccounts?: (providerId: string) => Promise<Array<{ id: string; label: string }>>;
      };
      if (!auth.getAccounts) {
        return { supported: false, message: 'vscode.authentication.getAccounts not available in this VSCode version' };
      }
      const accounts = await auth.getAccounts(p.providerId);
      return { supported: true, accounts };
    },
  });
}
