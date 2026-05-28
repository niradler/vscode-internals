import * as vscode from 'vscode';
import type { EndpointRegistry } from '../registry';

/**
 * Source Control endpoints. The vscode.scm.* API exposes input boxes and the
 * presentation surface; the actual data lives in source control providers (e.g. git).
 * For deeper git introspection, prefer the git extension's public API (which we
 * surface here through a helper) or shell out to `git` via terminal endpoints.
 */
export function registerScmRoutes(registry: EndpointRegistry, owner: string): void {
  const reg = (def: Parameters<EndpointRegistry['register']>[0]) =>
    registry.register({ tag: 'scm', ...def }, owner);

  reg({
    method: 'GET',
    path: '/scm/inputBox',
    summary: 'Read the source control input box (commit message) of the first SCM provider',
    handler: () => {
      // vscode.scm doesn't expose providers as a list; the input box is per provider.
      // We probe the git extension because that's the dominant SCM provider.
      const git = vscode.extensions.getExtension('vscode.git');
      if (!git) return { available: false, reason: 'git extension not present' };
      return { available: true, hint: 'use /scm/git/* endpoints for richer git access' };
    },
  });

  reg({
    method: 'GET',
    path: '/scm/git/repositories',
    summary: 'List git repositories discovered by the built-in git extension',
    handler: async () => {
      const api = await getGitApi();
      if (!api) return { available: false };
      return {
        available: true,
        repositories: api.repositories.map((r: GitRepository) => ({
          rootUri: r.rootUri.toString(),
          headBranch: r.state.HEAD?.name ?? null,
          headCommit: r.state.HEAD?.commit ?? null,
          remotes: r.state.remotes.map((rem) => ({ name: rem.name, fetchUrl: rem.fetchUrl, pushUrl: rem.pushUrl })),
          workingTreeChanges: r.state.workingTreeChanges.length,
          indexChanges: r.state.indexChanges.length,
          mergeChanges: r.state.mergeChanges.length,
        })),
      };
    },
  });

  reg({
    method: 'POST',
    path: '/scm/git/status',
    summary: 'Detailed status of a git repository (working tree, index, merge)',
    params: {
      type: 'object',
      properties: { rootUri: { type: 'string', description: 'Repo root URI; default first repo' } },
    },
    handler: async (raw) => {
      const p = raw as { rootUri?: string };
      const api = await getGitApi();
      if (!api) throw new Error('git extension not available');
      const repo = p.rootUri
        ? api.repositories.find((r: GitRepository) => r.rootUri.toString() === p.rootUri)
        : api.repositories[0];
      if (!repo) throw new Error('Repository not found');
      const describe = (c: GitChange) => ({
        uri: c.uri.toString(),
        originalUri: c.originalUri?.toString(),
        renameUri: c.renameUri?.toString(),
        status: c.status,
      });
      return {
        rootUri: repo.rootUri.toString(),
        head: repo.state.HEAD ? {
          name: repo.state.HEAD.name,
          commit: repo.state.HEAD.commit,
          upstream: repo.state.HEAD.upstream,
          ahead: repo.state.HEAD.ahead,
          behind: repo.state.HEAD.behind,
        } : null,
        workingTreeChanges: repo.state.workingTreeChanges.map(describe),
        indexChanges: repo.state.indexChanges.map(describe),
        mergeChanges: repo.state.mergeChanges.map(describe),
      };
    },
  });
}

/**
 * Minimal subset of the built-in git extension's exported API.
 * Reference: https://github.com/microsoft/vscode/blob/main/extensions/git/src/api/git.d.ts
 */
interface GitExtensionExports { getAPI(version: 1): GitAPI; }
interface GitAPI { repositories: GitRepository[]; }
interface GitRepository {
  rootUri: vscode.Uri;
  state: {
    HEAD?: { name?: string; commit?: string; upstream?: unknown; ahead?: number; behind?: number };
    remotes: Array<{ name: string; fetchUrl?: string; pushUrl?: string }>;
    workingTreeChanges: GitChange[];
    indexChanges: GitChange[];
    mergeChanges: GitChange[];
  };
}
interface GitChange { uri: vscode.Uri; originalUri?: vscode.Uri; renameUri?: vscode.Uri; status: number; }

async function getGitApi(): Promise<GitAPI | null> {
  const ext = vscode.extensions.getExtension<GitExtensionExports>('vscode.git');
  if (!ext) return null;
  const exports = await ext.activate();
  return exports.getAPI(1);
}
