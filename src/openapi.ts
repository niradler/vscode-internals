import type { EndpointRegistry } from './registry';

export interface OpenAPIDoc {
  openapi: '3.1.0';
  info: { title: string; version: string; description?: string };
  servers?: Array<{ url: string }>;
  components: { securitySchemes: Record<string, unknown>; schemas?: Record<string, unknown> };
  security: Array<Record<string, string[]>>;
  paths: Record<string, Record<string, unknown>>;
  tags?: Array<{ name: string; description?: string }>;
}

export function buildOpenAPI(registry: EndpointRegistry, opts: { baseUrl?: string; version: string }): OpenAPIDoc {
  const doc: OpenAPIDoc = {
    openapi: '3.1.0',
    info: {
      title: 'VSCode Internals API',
      version: opts.version,
      description:
        'Local REST + SSE access to the running VSCode instance. Token-protected, loopback-bound by default. ' +
        'Endpoints come from two sources: built-in routes (tag prefix matches the vscode namespace) and ' +
        'endpoints registered dynamically by other extensions via the public API.',
    },
    servers: opts.baseUrl ? [{ url: opts.baseUrl }] : undefined,
    components: {
      securitySchemes: {
        bearerAuth: { type: 'http', scheme: 'bearer', description: 'Bearer token from VSCode SecretStorage' },
      },
    },
    security: [{ bearerAuth: [] }],
    paths: {},
    tags: [],
  };

  const seenTags = new Set<string>();
  for (const ep of registry.list()) {
    const path = ep.path;
    const method = ep.method.toLowerCase();
    if (!doc.paths[path]) doc.paths[path] = {};

    const tag = ep.tag ?? ep.ownerId;
    if (!seenTags.has(tag)) {
      seenTags.add(tag);
      doc.tags!.push({ name: tag, description: ep.ownerId === 'core' ? undefined : `Registered by extension ${ep.ownerId}` });
    }

    const operation: Record<string, unknown> = {
      summary: ep.summary,
      description: ep.description,
      tags: [tag],
      operationId: makeOperationId(method, path),
      'x-owner': ep.ownerId,
    };

    if (ep.params) {
      if (method === 'get' || method === 'delete') {
        operation.parameters = paramsToQueryParameters(ep.params);
      } else {
        operation.requestBody = {
          required: true,
          content: { 'application/json': { schema: ep.params } },
        };
      }
    }

    operation.responses = {
      '200': {
        description: 'OK',
        content: { 'application/json': { schema: ep.response ?? { type: 'object' } } },
      },
      '400': { description: 'Bad request' },
      '401': { description: 'Unauthorized' },
      '500': { description: 'Server error' },
    };

    doc.paths[path][method] = operation;
  }

  return doc;
}

function makeOperationId(method: string, path: string): string {
  const segs = path.split('/').filter(Boolean).map(s => s.replace(/[^a-zA-Z0-9]+/g, '_'));
  return `${method}_${segs.join('_')}`;
}

interface JSONSchemaShape {
  type?: string;
  properties?: Record<string, JSONSchemaShape>;
  required?: string[];
  description?: string;
}

function paramsToQueryParameters(schema: JSONSchemaShape): Array<Record<string, unknown>> {
  if (schema.type !== 'object' || !schema.properties) return [];
  const required = new Set(schema.required ?? []);
  return Object.entries(schema.properties).map(([name, prop]) => ({
    name,
    in: 'query',
    required: required.has(name),
    description: prop.description,
    schema: prop,
  }));
}

/**
 * Swagger UI HTML pointing at locally-served assets from `swagger-ui-dist`.
 * No CDN — avoids Subresource Integrity bookkeeping and CDN-compromise risk.
 * Assets are served from `/docs/assets/...` by the express server.
 */
export function swaggerUiHtml(specUrl: string, assetsPath: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <title>VSCode Internals API</title>
  <link rel="stylesheet" href="${assetsPath}/swagger-ui.css" />
  <style>body { margin: 0; }</style>
</head>
<body>
  <div id="swagger-ui"></div>
  <script src="${assetsPath}/swagger-ui-bundle.js"></script>
  <script>
    window.onload = () => {
      SwaggerUIBundle({
        url: ${JSON.stringify(specUrl)},
        dom_id: '#swagger-ui',
        deepLinking: true,
        persistAuthorization: true,
      });
    };
  </script>
</body>
</html>`;
}
