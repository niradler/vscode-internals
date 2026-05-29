import type { EndpointRegistry } from '../registry';
import { registerAuthenticationRoutes } from './authentication';
import { registerCommandsRoutes } from './commands';
import { registerCursorRoutes } from './cursor';
import { registerDebugRoutes } from './debug';
import { registerDevRoutes, type DevDeps } from './dev';
import { registerEnvRoutes } from './env';
import { registerExtensionsRoutes } from './extensions';
import { registerLanguagesRoutes } from './languages';
import { registerLmRoutes } from './lm';
import { registerNotebooksRoutes } from './notebooks';
import { registerPortsRoutes } from './ports';
import { registerScmRoutes } from './scm';
import { registerTabsRoutes } from './tabs';
import { registerTasksRoutes } from './tasks';
import { registerTestsRoutes } from './tests';
import { registerWindowRoutes } from './window';
import { registerWorkspaceRoutes } from './workspace';

export { registerDevRoutes, type DevDeps };

export function registerAllBuiltinRoutes(registry: EndpointRegistry, ownerId: string): void {
  registerWorkspaceRoutes(registry, ownerId);
  registerWindowRoutes(registry, ownerId);
  registerTabsRoutes(registry, ownerId);
  registerLanguagesRoutes(registry, ownerId);
  registerLmRoutes(registry, ownerId);
  registerCommandsRoutes(registry, ownerId);
  registerDebugRoutes(registry, ownerId);
  registerTasksRoutes(registry, ownerId);
  registerScmRoutes(registry, ownerId);
  registerTestsRoutes(registry, ownerId);
  registerNotebooksRoutes(registry, ownerId);
  registerEnvRoutes(registry, ownerId);
  registerPortsRoutes(registry, ownerId);
  registerAuthenticationRoutes(registry, ownerId);
  registerExtensionsRoutes(registry, ownerId);
  registerCursorRoutes(registry, ownerId);
}
