// Global registry of running VSCode Internals instances, persisted to
// `~/.vscode-internals/instances.json`. Lets a caller discover every VSCode
// window on the machine that is exposing this extension's HTTP API, so they
// can find the right instance for a given workspace/PID/port without scanning.
//
// Concurrency model: a coarse mkdir-based lock + atomic rename. mkdir is
// atomic across processes on POSIX and Windows; we treat a lock older than
// LOCK_STALE_MS as abandoned. The file is informational — losing a single
// update is acceptable.
//
// Cleanup model: on every register() we prune entries whose `pid` is no
// longer alive (via `process.kill(pid, 0)`). On deactivate, the window
// removes its own entry.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { Logger } from './logger';

export const REGISTRY_DIR = path.join(os.homedir(), '.vscode-internals');
export const REGISTRY_FILE = path.join(REGISTRY_DIR, 'instances.json');
const REGISTRY_LOCK = path.join(REGISTRY_DIR, 'instances.lock');
const SCHEMA_VERSION = 1;
const LOCK_TIMEOUT_MS = 2_000;
const LOCK_STALE_MS = 10_000;

export interface InstanceRecord {
  sessionId: string;
  pid: number;
  host: string;
  port: number;
  url: string;
  appName: string;
  appHost: string;
  remoteName: string | null;
  workspaceName: string | null;
  workspaceFolders: string[];
  extensionVersion: string;
  vscodeVersion: string;
  startedAt: string;
}

interface RegistryFile {
  version: number;
  instances: InstanceRecord[];
}

export class InstancesRegistry {
  constructor(private readonly logger: Logger) {}

  /** Insert/replace this window's entry. Prunes dead entries first. */
  async register(rec: InstanceRecord): Promise<void> {
    await this.withLock(() => {
      const data = this.readSafe();
      const live = pruneDead(data.instances, this.logger);
      const filtered = live.filter((i) => i.sessionId !== rec.sessionId && i.pid !== rec.pid);
      filtered.push(rec);
      this.write({ version: SCHEMA_VERSION, instances: filtered });
    });
  }

  /** Remove this window's entry by sessionId. Best-effort. */
  async unregister(sessionId: string): Promise<void> {
    await this.withLock(() => {
      const data = this.readSafe();
      const filtered = data.instances.filter((i) => i.sessionId !== sessionId);
      this.write({ version: SCHEMA_VERSION, instances: filtered });
    });
  }

  /** Read the current registry (read-only). Returns a fresh copy. */
  read(): RegistryFile {
    return this.readSafe();
  }

  private readSafe(): RegistryFile {
    try {
      const raw = fs.readFileSync(REGISTRY_FILE, 'utf8');
      const parsed = JSON.parse(raw) as RegistryFile;
      if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.instances)) {
        return { version: SCHEMA_VERSION, instances: [] };
      }
      return parsed;
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code !== 'ENOENT') {
        this.logger.debug(`instances.json unreadable, treating as empty: ${e.message}`);
      }
      return { version: SCHEMA_VERSION, instances: [] };
    }
  }

  private write(data: RegistryFile): void {
    const tmp = `${REGISTRY_FILE}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, REGISTRY_FILE);
  }

  private async withLock(fn: () => void): Promise<void> {
    ensureRegistryDir();
    const acquired = await acquireLock(REGISTRY_LOCK, LOCK_TIMEOUT_MS);
    if (!acquired) {
      this.logger.warn(`instances.json lock contended for >${LOCK_TIMEOUT_MS}ms; writing anyway`);
    }
    try {
      fn();
    } finally {
      try { fs.rmdirSync(REGISTRY_LOCK); } catch { /* ignore */ }
    }
  }
}

/**
 * Create REGISTRY_DIR with 0700 if missing, and tighten the mode if it already
 * exists with looser permissions (e.g. left over from an earlier build that
 * created it with the default umask). chmod is a no-op on Windows.
 */
function ensureRegistryDir(): void {
  fs.mkdirSync(REGISTRY_DIR, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') {
    try {
      const stat = fs.statSync(REGISTRY_DIR);
      if ((stat.mode & 0o777) !== 0o700) {
        fs.chmodSync(REGISTRY_DIR, 0o700);
      }
    } catch { /* ignore */ }
  }
}

function pruneDead(instances: InstanceRecord[], log: Logger): InstanceRecord[] {
  return instances.filter((i) => {
    if (i.pid === process.pid) return true;
    if (!Number.isInteger(i.pid) || i.pid <= 0) return false;
    try {
      process.kill(i.pid, 0);
      return true;
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      // EPERM means the process exists but we don't have signal permission —
      // still alive. ESRCH (and anything else) means dead.
      if (e.code === 'EPERM') return true;
      log.debug(`Pruning dead instance pid=${i.pid} sessionId=${i.sessionId}`);
      return false;
    }
  });
}

async function acquireLock(lockPath: string, timeoutMs: number): Promise<boolean> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      fs.mkdirSync(lockPath);
      return true;
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code !== 'EEXIST') throw err;
      try {
        const stat = fs.statSync(lockPath);
        if (Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
          try { fs.rmdirSync(lockPath); } catch { /* ignore */ }
          continue;
        }
      } catch { /* ignore */ }
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  return false;
}
