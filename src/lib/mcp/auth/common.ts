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
  getSessionJwt: () => Promise<string>;
}

export interface McpAuthenticator {
  authenticate(env: Env, request: Request): Promise<McpCaller | null>;
}

export function bearerToken(request: Request): string | null {
  const authorization = request.headers.get('authorization');
  return authorization?.startsWith('Bearer ') ? authorization.slice('Bearer '.length) : null;
}

export async function resolveUserFromSessionToken(env: Env, token: string): Promise<McpUser | null> {
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
