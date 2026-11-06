import { Elysia } from 'elysia';
import { CloudflareAdapter } from 'elysia/adapter/cloudflare-worker';
import { env as cfEnv } from 'cloudflare:workers';
import { resolveEnv } from './constants';
import { appPublicKey } from './lib/app-key';
import { fetchSessionJwtForCaller, resolveMcpCaller } from './lib/mcp/auth';
import { appPublicKeyResponseSchema, jsonRpcRequestSchema, jsonRpcResponseSchema } from './lib/mcp/schemas';
import { handleMcpMessage, type McpContext } from './lib/mcp/server';

const env = resolveEnv(cfEnv as Env);

const app = new Elysia({ adapter: CloudflareAdapter, aot: false })
  .model({
    'json-rpc-request': jsonRpcRequestSchema,
    'json-rpc-response': jsonRpcResponseSchema,
    'app-public-key-response': appPublicKeyResponseSchema,
  })
  .onError(({ code, set }) => {
    if (code === 'PARSE') {
      set.status = 400;
      return { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } };
    }
    if (code === 'VALIDATION') {
      set.status = 400;
      return { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } };
    }
  })
  .post(
    '/mcp',
    async ({ body, request }) => {
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

      const response = await handleMcpMessage(body, context);
      if (!response.body) return new Response(null, { status: response.status });

      const init: ResponseInit = { status: response.status, headers: { 'content-type': 'application/json' } };
      if (response.status === 401) {
        (init.headers as Record<string, string>)['www-authenticate'] = 'Bearer';
      }
      return Response.json(response.body, init);
    },
    { body: 'json-rpc-request', response: 'json-rpc-response' }
  )
  .get(
    '/mcp',
    ({ set }) => {
      set.status = 405;
      set.headers.allow = 'POST';
      return { jsonrpc: '2.0', id: null, error: { code: -32601, message: 'Method Not Allowed' } };
    },
    { response: 'json-rpc-response' }
  )
  .get('/.well-known/app-public-key', () => ({ appId: env.APP_ID, publicKey: appPublicKey(env) }), {
    response: 'app-public-key-response',
  });

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
