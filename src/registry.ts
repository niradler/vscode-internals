import type { Request } from 'express';
import type * as vscode from 'vscode';
import type { Logger } from './logger';
import type { Serializer } from './serializer';

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';

export interface JSONSchema {
  type?: string;
  properties?: Record<string, JSONSchema>;
  items?: JSONSchema;
  required?: string[];
  description?: string;
  enum?: unknown[];
  oneOf?: JSONSchema[];
  anyOf?: JSONSchema[];
  additionalProperties?: boolean | JSONSchema;
  [key: string]: unknown;
}

export interface EndpointContext {
  vscode: typeof vscode;
  logger: Logger;
  serializer: Serializer;
  req: Request;
}

export interface EndpointDefinition {
  method: HttpMethod;
  path: string;
  summary: string;
  description?: string;
  tag?: string;
  params?: JSONSchema;
  response?: JSONSchema;
  handler: (params: unknown, ctx: EndpointContext) => Promise<unknown> | unknown;
}

export interface RegisteredEndpoint extends EndpointDefinition {
  ownerId: string; // 'core' for built-ins, extensionId for third-party
}

export class EndpointRegistry {
  private endpoints = new Map<string, RegisteredEndpoint>();
  private listeners: Array<() => void> = [];

  private key(method: HttpMethod, path: string): string {
    return `${method.toUpperCase()} ${path}`;
  }

  register(def: EndpointDefinition, ownerId: string): void {
    const k = this.key(def.method, def.path);
    if (this.endpoints.has(k)) {
      throw new Error(`Endpoint already registered: ${k} (owner ${this.endpoints.get(k)!.ownerId})`);
    }
    this.endpoints.set(k, { ...def, ownerId });
    this.emit();
  }

  unregister(method: HttpMethod, path: string): boolean {
    const removed = this.endpoints.delete(this.key(method, path));
    if (removed) this.emit();
    return removed;
  }

  unregisterAllByOwner(ownerId: string): number {
    let n = 0;
    for (const [k, ep] of this.endpoints) {
      if (ep.ownerId === ownerId) {
        this.endpoints.delete(k);
        n++;
      }
    }
    if (n > 0) this.emit();
    return n;
  }

  list(): RegisteredEndpoint[] {
    return [...this.endpoints.values()];
  }

  find(method: HttpMethod, path: string): RegisteredEndpoint | undefined {
    return this.endpoints.get(this.key(method, path));
  }

  onChange(cb: () => void): () => void {
    this.listeners.push(cb);
    return () => {
      const i = this.listeners.indexOf(cb);
      if (i >= 0) this.listeners.splice(i, 1);
    };
  }

  private emit(): void {
    for (const cb of this.listeners) {
      try { cb(); } catch { /* ignore listener errors */ }
    }
  }
}
