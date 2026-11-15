// app.ts — HTTP composition: one server, four surfaces, one store.
//
// Routing and cross-cutting concerns live here so the surface modules stay
// focused: every response carries an X-GitHub-Request-Id, every surface
// except the health probe requires the bearer token when one is configured,
// and request bodies are collected once and handed to the right handler.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

import { Forge } from './forge.ts';
import { handleGit } from './githttp.ts';
import { executeGraphQL, type GraphQLRequestBody } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { handleRest } from './rest.ts';

const MAX_BODY_BYTES = 96 * 1024 * 1024;

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function sendBuffer(res: ServerResponse, status: number, body: Buffer, contentType: string): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': body.length });
  res.end(body);
}

function sendJson(res: ServerResponse, status: number, value: unknown): void {
  sendBuffer(res, status, Buffer.from(JSON.stringify(value), 'utf8'), 'application/json; charset=utf-8');
}

export interface ForgeApp {
  server: Server;
  forge: Forge;
}

/** Build the forge HTTP server. `token` empty means: no auth (dev mode). */
export function createApp(token: string): ForgeApp {
  const forge = new Forge();
  let requestCounter = 0;

  const server = createServer((req, res) => {
    requestCounter += 1;
    res.setHeader('x-github-request-id', `req-${requestCounter}`);
    void dispatch(req, res).catch(() => {
      if (!res.headersSent) sendJson(res, 500, { message: 'Internal Server Error' });
      else res.end();
    });
  });
  // The read workload holds one keep-alive connection for thousands of
  // sequential requests; keep it alive well past the default five seconds.
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;

  async function dispatch(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const method = req.method ?? 'GET';
    const url = new URL(req.url ?? '/', 'http://forge.internal');
    let pathname = url.pathname;
    try {
      pathname = decodeURIComponent(url.pathname);
    } catch {
      pathname = url.pathname;
    }
    const query = url.searchParams;

    if (pathname === '/healthz') {
      sendJson(res, 200, { ok: true });
      return;
    }

    if (token !== '') {
      const header = req.headers.authorization ?? '';
      if (header !== `Bearer ${token}`) {
        sendJson(res, 401, { message: 'Bad credentials' });
        return;
      }
    }

    if (pathname === '/api/graphql' && method === 'POST') {
      const raw = (await readBody(req)).toString('utf8');
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        sendJson(res, 400, { errors: [{ message: 'Invalid JSON body' }] });
        return;
      }
      if (Array.isArray(parsed)) {
        sendJson(res, 200, parsed.map((entry) => executeGraphQL(forge, entry as GraphQLRequestBody)));
      } else {
        sendJson(res, 200, executeGraphQL(forge, parsed as GraphQLRequestBody));
      }
      return;
    }

    if (pathname === '/mcp' && method === 'POST') {
      const outcome = handleMcp(forge, await readBody(req));
      if (outcome.body === null) {
        res.writeHead(outcome.status);
        res.end();
      } else {
        sendJson(res, outcome.status, outcome.body);
      }
      return;
    }

    if (pathname === '/api/v3' || pathname.startsWith('/api/v3/')) {
      const raw = (await readBody(req)).toString('utf8');
      let body: unknown;
      let badJson = false;
      if (raw !== '') {
        try {
          body = JSON.parse(raw);
        } catch {
          badJson = true;
        }
      }
      const segments = pathname
        .slice('/api/v3'.length)
        .split('/')
        .filter((segment) => segment !== '');
      handleRest({ forge, req, res, segments, query, body, badJson });
      return;
    }

    const gitMatch = /^\/([^/]+)\/([^/]+)\.git(\/.*)$/.exec(pathname);
    if (gitMatch !== null) {
      const body = await readBody(req);
      handleGit(forge, req, res, gitMatch[1], gitMatch[2], gitMatch[3], query, body);
      return;
    }

    sendJson(res, 404, { message: 'Not Found' });
  }

  return { server, forge };
}
