import * as crypto from 'crypto';
import * as vscode from 'vscode';
import type { RequestHandler } from 'express';

const SECRET_KEY = 'vscodeInternals.bearerToken';

export class TokenManager {
  constructor(private secrets: vscode.SecretStorage) {}

  async getOrCreate(): Promise<string> {
    const existing = await this.secrets.get(SECRET_KEY);
    if (existing) return existing;
    const fresh = generateToken();
    await this.secrets.store(SECRET_KEY, fresh);
    return fresh;
  }

  async regenerate(): Promise<string> {
    const fresh = generateToken();
    await this.secrets.store(SECRET_KEY, fresh);
    return fresh;
  }

  async current(): Promise<string | undefined> {
    return this.secrets.get(SECRET_KEY);
  }
}

function generateToken(): string {
  // 32 bytes -> 64 hex chars. Prefixed for easy identification in logs.
  return 'vscint_' + crypto.randomBytes(32).toString('hex');
}

// Routes that bypass auth — must remain trivially harmless.
const PUBLIC_PATHS = new Set<string>(['/health', '/openapi.json', '/docs']);

export function authMiddleware(getToken: () => Promise<string>): RequestHandler {
  return async (req, res, next) => {
    if (PUBLIC_PATHS.has(req.path) || req.path.startsWith('/docs/')) {
      return next();
    }
    const header = req.header('authorization') ?? '';
    const match = header.match(/^Bearer\s+(.+)$/i);
    if (!match) {
      res.status(401).json({ error: 'missing_authorization', message: 'Expected Authorization: Bearer <token>' });
      return;
    }
    const provided = match[1].trim();
    const expected = await getToken();
    if (!constantTimeEquals(provided, expected)) {
      res.status(401).json({ error: 'invalid_token' });
      return;
    }
    next();
  };
}

function constantTimeEquals(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}
