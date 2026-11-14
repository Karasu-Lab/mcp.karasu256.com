import { Elysia } from 'elysia';
import { CloudflareAdapter } from 'elysia/adapter/cloudflare-worker';
import { env as cfEnv } from 'cloudflare:workers';
import { z } from 'zod';
import { resolveEnv } from './constants';
import { appPublicKey } from './lib/app-key';
import { ClaudeCommands, MuseConnectorCommands } from './commands';
import { ClaudeAuthenticator } from './lib/mcp/auth/claude';
import type { McpCaller } from './lib/mcp/auth/common';
import { MuseConnectorAuthenticator } from './lib/mcp/auth/muse';
import { authorizationServerMetadata, forwardToAuthServer, isOAuthPath, oauthPreflight, withOAuthCors } from './lib/mcp/oauth';
import { bearerChallenge,protectedResourceMetadata, resourceMetadataPath } from './lib/mcp/resource-metadata';
import { appPublicKeyResponseSchema, jsonRpcRequestSchema, jsonRpcResponseSchema, type JsonRpcResponse } from './lib/mcp/schemas';
import { handleMcpMessage, type McpContext, type ToolDispatch } from './lib/mcp/server';

const env = resolveEnv(cfEnv as Env);

async function respond(
  body: unknown,
  caller: McpCaller | null,
  tools: ToolDispatch[],
  set: { status?: number | string; headers: Record<string, string | number> }
): Promise<JsonRpcResponse | undefined> {
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
      sessionJwtPromise ??= caller.getSessionJwt();
      return sessionJwtPromise;
    },
    tools,
  };

  const response = await handleMcpMessage(body, context);
  set.status = response.status;
  if (!response.body) return undefined;
  if (response.status === 401) set.headers['www-authenticate'] = 'Bearer';
  return response.body;
}

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
    async ({ body, request, set }) => {
      const claudeCaller = await new ClaudeAuthenticator().authenticate(env, request).catch(() => null);
      const caller = claudeCaller ?? (await new MuseConnectorAuthenticator().authenticate(env, request).catch(() => null));
      if (!caller) {
        set.status = 401;
        set.headers['www-authenticate'] = bearerChallenge(env);
        return { jsonrpc: '2.0' as const, id: body.id ?? null, error: { code: -32001, message: 'Unauthorized' } };
      }
      const commands = claudeCaller ? new ClaudeCommands() : new MuseConnectorCommands();
      return respond(body, caller, commands.list(), set);
    },
    {
      body: 'json-rpc-request',
      response: { 200: 'json-rpc-response', 202: z.undefined(), 400: 'json-rpc-response', 401: 'json-rpc-response' },
    }
  )
  .post(
    '/muse/mcp',
    async ({ body, request, set }) => {
      const caller = await new MuseConnectorAuthenticator().authenticate(env, request).catch(() => null);
      return respond(body, caller, new MuseConnectorCommands().list(), set);
    },
    {
      body: 'json-rpc-request',
      response: { 200: 'json-rpc-response', 202: z.undefined(), 400: 'json-rpc-response', 401: 'json-rpc-response' },
    }
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
  .get(resourceMetadataPath(env), () => protectedResourceMetadata(env))
  .get('/.well-known/oauth-protected-resource', () => protectedResourceMetadata(env))
  .get('/.well-known/oauth-authorization-server', () => authorizationServerMetadata(env))
  .get('/.well-known/openid-configuration', () => authorizationServerMetadata(env))
  .all('/oauth2/*', ({ request }) => forwardToAuthServer(env, request), { parse: 'none' })
  .all('/device/*', ({ request }) => forwardToAuthServer(env, request), { parse: 'none' })
  .all('/jwks', ({ request }) => forwardToAuthServer(env, request), { parse: 'none' })
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
  async fetch(rawRequest: Request): Promise<Response> {
    const request = normalizePath(rawRequest);
    if (!isOAuthPath(new URL(request.url).pathname)) return app.fetch(request);
    if (request.method === 'OPTIONS') return oauthPreflight();
    return withOAuthCors(await app.fetch(request));
  },
};
