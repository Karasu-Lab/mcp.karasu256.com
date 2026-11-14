export function publicOrigin(env: Env): string {
  return new URL(env.MCP_URL).origin;
}

export function isOAuthPath(pathname: string): boolean {
  return ['/.well-known/', '/oauth2/', '/device/', '/jwks'].some((prefix) => pathname.startsWith(prefix));
}

export function isProxiedPath(pathname: string): boolean {
  return ['/oauth2/', '/device/'].some((prefix) => pathname.startsWith(prefix)) || pathname === '/jwks';
}

export function withOAuthCors(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set('access-control-allow-origin', '*');
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

export function oauthPreflight(): Response {
  return new Response(null, {
    status: 204,
    headers: {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET, POST, OPTIONS',
      'access-control-allow-headers': 'authorization, content-type, mcp-protocol-version',
    },
  });
}

async function fetchUpstreamMetadata(env: Env): Promise<Record<string, unknown>> {
  const res = await fetch(`${env.AUTH_API_URL}/api/auth/.well-known/oauth-authorization-server`, { cache: 'no-store' });
  if (!res.ok) throw new Error(`api-auth authorization server metadata failed: ${res.status}`);
  return (await res.json()) as Record<string, unknown>;
}

/**
 * Authorization server metadata whose endpoints all live on this worker, so MCP clients
 * start the OAuth flow here instead of at api-auth.
 */
export async function authorizationServerMetadata(env: Env): Promise<Record<string, unknown>> {
  const upstream = await fetchUpstreamMetadata(env);
  const origin = publicOrigin(env);
  const upstreamBase = `${env.AUTH_API_URL}/api/auth/`;

  const metadata: Record<string, unknown> = { ...upstream, issuer: origin };
  for (const [key, value] of Object.entries(upstream)) {
    const isEndpoint = key.endsWith('_endpoint') || key === 'jwks_uri';
    if (isEndpoint && typeof value === 'string' && value.startsWith(upstreamBase)) {
      metadata[key] = `${origin}/${value.slice(upstreamBase.length)}`;
    }
  }
  // The authorization response carries api-auth's issuer, which differs from the issuer advertised here.
  delete metadata.authorization_response_iss_parameter_supported;
  return metadata;
}

/**
 * Forwards an OAuth endpoint request to api-auth. The authorize endpoint is redirected instead
 * of proxied because it runs in the user's browser and relies on api-auth's session cookies.
 */
export async function forwardToAuthServer(env: Env, request: Request): Promise<Response> {
  const url = new URL(request.url);
  const target = new URL(`${env.AUTH_API_URL}/api/auth${url.pathname}${url.search}`);

  if (url.pathname === '/oauth2/authorize') return Response.redirect(target.toString(), 302);

  const headers = new Headers();
  for (const name of ['authorization', 'content-type', 'accept']) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  const hasBody = request.method !== 'GET' && request.method !== 'HEAD';
  return fetch(target, {
    method: request.method,
    headers,
    body: hasBody ? await request.arrayBuffer() : undefined,
    redirect: 'manual',
    cache: 'no-store',
  });
}
