import { bearerToken, fetchSessionJwt, resolveUserFromSessionToken, type McpAuthenticator, type McpCaller } from './common';

export class MuseConnectorAuthenticator implements McpAuthenticator {
  async authenticate(env: Env, request: Request): Promise<McpCaller | null> {
    for (const token of [this.sessionTokenFromCookie(request.headers.get('cookie')), bearerToken(request)]) {
      if (!token) continue;
      const user = await resolveUserFromSessionToken(env, token).catch(() => null);
      if (user) return { user, scopes: null, sessionToken: token, accessToken: null, getSessionJwt: () => fetchSessionJwt(env, token) };
    }
    return null;
  }

  private sessionTokenFromCookie(cookieHeader: string | null): string | null {
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
}
