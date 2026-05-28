import * as vscode from 'vscode';
import type { EndpointRegistry } from '../registry';

export function registerTasksRoutes(registry: EndpointRegistry, owner: string): void {
  const reg = (def: Parameters<EndpointRegistry['register']>[0]) =>
    registry.register({ tag: 'tasks', ...def }, owner);

  reg({
    method: 'GET',
    path: '/tasks/list',
    summary: 'List tasks discovered by VSCode (from tasks.json and task providers)',
    handler: async () => {
      const tasks = await vscode.tasks.fetchTasks();
      return tasks.map((t) => ({
        name: t.name,
        source: t.source,
        definition: t.definition,
        group: t.group?.id,
        detail: t.detail,
        scope: typeof t.scope === 'object' ? (t.scope as vscode.WorkspaceFolder).name : t.scope,
      }));
    },
  });

  reg({
    method: 'POST',
    path: '/tasks/execute',
    summary: 'Execute a task by name (matches the first task with that name)',
    params: {
      type: 'object',
      properties: { name: { type: 'string' } },
      required: ['name'],
    },
    handler: async (raw) => {
      const p = raw as { name: string };
      const tasks = await vscode.tasks.fetchTasks();
      const task = tasks.find((t) => t.name === p.name);
      if (!task) throw new Error(`Task not found: ${p.name}`);
      const execution = await vscode.tasks.executeTask(task);
      return { started: true, name: execution.task.name };
    },
  });

  reg({
    method: 'GET',
    path: '/tasks/executions',
    summary: 'List currently running task executions',
    handler: () => vscode.tasks.taskExecutions.map((e) => ({
      name: e.task.name,
      source: e.task.source,
    })),
  });

  reg({
    method: 'POST',
    path: '/tasks/terminate',
    summary: 'Terminate a running task by name',
    params: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
    handler: (raw) => {
      const p = raw as { name: string };
      const exec = vscode.tasks.taskExecutions.find((e) => e.task.name === p.name);
      if (!exec) throw new Error(`No running execution for task: ${p.name}`);
      exec.terminate();
      return { ok: true };
    },
  });
}
