import { createRemoteJWKSet, jwtVerify } from 'jose';
import { buildSignedAuthRequest, sendSignedAuthRequest } from '../auth/remote';

export interface McpUser {
  id: string;
  email: string | null;
  name: string | null;
  image: string | null;
}

export interface McpCaller {
  user: McpUser;
  scopes: string[] | null;
  sessionToken: string | null;
  accessToken: string | null;
}

const jwksByIssuer = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

function getJwks(issuer: string): ReturnType<typeof createRemoteJWKSet> {
  const existing = jwksByIssuer.get(issuer);
  if (existing) return existing;
  const jwks = createRemoteJWKSet(new URL(`${issuer}/jwks`));
  jwksByIssuer.set(issuer, jwks);
  return jwks;
}

interface OAuthAccessTokenClaims {
  userId: string;
  scopes: string[];
}

async function verifyOAuthAccessToken(env: Env, token: string): Promise<OAuthAccessTokenClaims | null> {
  const issuer = `${env.AUTH_API_URL}/api/auth`;
  try {
    const { payload } = await jwtVerify(token, getJwks(issuer), { issuer, audience: issuer });
    if (!payload.sub) return null;
    return {
      userId: payload.sub,
      scopes: typeof payload.scope === 'string' ? payload.scope.split(' ').filter(Boolean) : [],
    };
  } catch {
    return null;
  }
}

async function resolveUserFromAccessToken(env: Env, token: string): Promise<McpUser | null> {
  const res = await fetch(`${env.AUTH_API_URL}/api/auth/oauth2/userinfo`, {
    headers: { authorization: `Bearer ${token}` },
    cache: 'no-store',
  }).catch(() => null);
  if (!res?.ok) return null;

  const data = (await res.json().catch(() => null)) as {
    sub?: string;
    email?: string | null;
    name?: string | null;
    picture?: string | null;
  } | null;
  if (!data?.sub) return null;
  return { id: data.sub, email: data.email ?? null, name: data.name ?? null, image: data.picture ?? null };
}

async function resolveUserFromSessionToken(env: Env, token: string): Promise<McpUser | null> {
  for (const cookieName of ['better-auth.session_token', '__Secure-better-auth.session_token']) {
    const res = await fetch(`${env.AUTH_API_URL}/api/auth/get-session`, {
      headers: { cookie: `${cookieName}=${token}` },
      cache: 'no-store',
    }).catch(() => null);
    if (!res?.ok) continue;

    const data = (await res.json().catch(() => null)) as {
      user?: { id: string; email?: string | null; name?: string | null; image?: string | null };
    } | null;
    if (data?.user) {
      return { id: data.user.id, email: data.user.email ?? null, name: data.user.name ?? null, image: data.user.image ?? null };
    }
  }
  return null;
}

function sessionTokenFromCookie(cookieHeader: string | null): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === 'better-auth.session_token' || name === '__Secure-better-auth.session_token') {
      const value = rest.join('=').trim();
      if (value) return decodeURIComponent(value);
    }
  }
  return null;
}

export async function resolveMcpCaller(env: Env, request: Request): Promise<McpCaller | null> {
  const cookieToken = sessionTokenFromCookie(request.headers.get('cookie'));
  if (cookieToken) {
    const user = await resolveUserFromSessionToken(env, cookieToken).catch(() => null);
    if (user) return { user, scopes: null, sessionToken: cookieToken, accessToken: null };
  }

  const authorization = request.headers.get('authorization');
  if (!authorization?.startsWith('Bearer ')) return null;
  const token = authorization.slice('Bearer '.length);

  const claims = await verifyOAuthAccessToken(env, token);
  if (claims) {
    const user = await resolveUserFromAccessToken(env, token).catch(() => null);
    if (!user || user.id !== claims.userId) return null;
    return { user, scopes: claims.scopes, sessionToken: null, accessToken: token };
  }

  const user = await resolveUserFromSessionToken(env, token).catch(() => null);
  if (user) return { user, scopes: null, sessionToken: token, accessToken: null };
  return null;
}

export async function fetchSessionJwtForCaller(env: Env, caller: McpCaller): Promise<string> {
  if (caller.sessionToken) return fetchSessionJwt(env, caller.sessionToken);
  if (caller.accessToken) {
    const request = buildSignedAuthRequest(env, '/api/internal/mcp/session-token', {
      method: 'POST',
      body: JSON.stringify({ accessToken: caller.accessToken }),
    });
    const res = await sendSignedAuthRequest(request).catch(() => null);
    if (res?.ok) {
      const { token } = (await res.json().catch(() => ({}))) as { token?: string };
      if (token) return token;
    }
    throw new Error(`api-auth session token exchange failed: ${res?.status ?? 'network error'}`);
  }
  throw new Error('api-auth session token exchange failed: the caller has no session');
}

export async function fetchSessionJwt(env: Env, sessionToken: string): Promise<string> {
  for (const cookieName of ['better-auth.session_token', '__Secure-better-auth.session_token']) {
    const res = await fetch(`${env.AUTH_API_URL}/api/auth/token`, {
      headers: { cookie: `${cookieName}=${sessionToken}` },
      cache: 'no-store',
    }).catch(() => null);
    if (!res?.ok) continue;
    const { token } = (await res.json().catch(() => ({}))) as { token?: string };
    if (token) return token;
  }
  throw new Error('api-auth session token exchange failed: 401');
}
