import { Elysia } from 'elysia';
import { CloudflareAdapter } from 'elysia/adapter/cloudflare-worker';
import { env as cfEnv } from 'cloudflare:workers';
import { resolveEnv } from './constants';
import { appPublicKey } from './lib/app-key';
import { fetchSessionJwtForCaller, resolveMcpCaller } from './lib/mcp/auth';
import { handleMcpMessage, type McpContext } from './lib/mcp/server';

const env = resolveEnv(cfEnv as Env);

const app = new Elysia({ adapter: CloudflareAdapter, aot: false, normalize: 'typebox' })
  .post('/mcp', async ({ request }) => {
    let message: unknown;
    try {
      message = await request.json();
    } catch {
      return Response.json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }, { status: 400 });
    }

    const caller = await resolveMcpCaller(env, request).catch(() => null);

    let sessionJwtPromise: Promise<string> | null = null;
    const context: McpContext = {
      env,
      user: caller?.user ?? null,
      scopes: caller?.scopes ?? null,
      sessionCookie: caller?.sessionToken ? `better-auth.session_token=${caller.sessionToken}` : null,
      getSessionJwt: () => {
        if (!caller) {
          return Promise.reject(new Error('api-auth session token exchange failed: the caller has no session'));
        }
        sessionJwtPromise ??= fetchSessionJwtForCaller(env, caller);
        return sessionJwtPromise;
      },
    };

    const response = await handleMcpMessage(message, context);
    if (!response.body) return new Response(null, { status: response.status });

    const init: ResponseInit = { status: response.status, headers: { 'content-type': 'application/json' } };
    if (response.status === 401) {
      (init.headers as Record<string, string>)['www-authenticate'] = 'Bearer';
    }
    return Response.json(response.body, init);
  })
  .get('/mcp', () => Response.json({ error: 'Method Not Allowed' }, { status: 405, headers: { allow: 'POST' } }))
  .get('/.well-known/app-public-key', () => Response.json({ appId: env.APP_ID, publicKey: appPublicKey(env) }));

function normalizePath(request: Request): Request {
  const url = new URL(request.url);
  const pathname = url.pathname.replace(/\/{2,}/g, '/');
  if (pathname === url.pathname) return request;
  url.pathname = pathname;
  return new Request(url, request);
}

export default {
  fetch: (request: Request) => app.fetch(normalizePath(request)),
};
