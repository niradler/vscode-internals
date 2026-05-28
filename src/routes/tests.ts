import * as vscode from 'vscode';
import type { EndpointRegistry } from '../registry';

/**
 * Testing API endpoints. The vscode.tests namespace exposes test controllers,
 * but most "list tests" / "run tests" workflows happen through the testing UI commands.
 * We surface what's available programmatically and provide a generic command bridge.
 */
export function registerTestsRoutes(registry: EndpointRegistry, owner: string): void {
  const reg = (def: Parameters<EndpointRegistry['register']>[0]) =>
    registry.register({ tag: 'tests', ...def }, owner);

  reg({
    method: 'POST',
    path: '/tests/runAll',
    summary: 'Trigger "Run All Tests" via the testing UI',
    handler: async () => {
      await vscode.commands.executeCommand('testing.runAll');
      return { ok: true };
    },
  });

  reg({
    method: 'POST',
    path: '/tests/runCurrentFile',
    summary: 'Run tests in the currently active file',
    handler: async () => {
      await vscode.commands.executeCommand('testing.runCurrentFile');
      return { ok: true };
    },
  });

  reg({
    method: 'POST',
    path: '/tests/debugAll',
    summary: 'Trigger "Debug All Tests"',
    handler: async () => {
      await vscode.commands.executeCommand('testing.debugAll');
      return { ok: true };
    },
  });

  reg({
    method: 'POST',
    path: '/tests/refresh',
    summary: 'Refresh the test explorer (re-discover tests)',
    handler: async () => {
      await vscode.commands.executeCommand('testing.refreshTests');
      return { ok: true };
    },
  });

  reg({
    method: 'POST',
    path: '/tests/cancelRun',
    summary: 'Cancel the current test run',
    handler: async () => {
      await vscode.commands.executeCommand('testing.cancelRun');
      return { ok: true };
    },
  });

  reg({
    method: 'POST',
    path: '/tests/showOutput',
    summary: 'Show the test output panel (so test results are visible to the user)',
    handler: async () => {
      await vscode.commands.executeCommand('testing.showMostRecentOutput');
      return { ok: true };
    },
  });
}
