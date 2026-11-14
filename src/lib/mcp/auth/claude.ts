import { createRemoteJWKSet, jwtVerify } from 'jose';
import { buildSignedAuthRequest, sendSignedAuthRequest } from '../../auth/remote';
import { bearerToken, type McpAuthenticator, type McpCaller, type McpUser } from './common';

const jwksByIssuer = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

function getJwks(issuer: string): ReturnType<typeof createRemoteJWKSet> {
  const existing = jwksByIssuer.get(issuer);
  if (existing) return existing;
  const jwks = createRemoteJWKSet(new URL(`${issuer}/jwks`));
  jwksByIssuer.set(issuer, jwks);
  return jwks;
}

export class ClaudeAuthenticator implements McpAuthenticator {
  async authenticate(env: Env, request: Request): Promise<McpCaller | null> {
    const token = bearerToken(request);
    if (!token) return null;
    const claims = await this.verifyAccessToken(env, token);
    if (!claims) return null;
    return {
      user: claims.user,
      scopes: claims.scopes,
      sessionToken: null,
      accessToken: token,
      getSessionJwt: () => this.exchangeSessionJwt(env, token),
    };
  }

  private async verifyAccessToken(env: Env, token: string): Promise<{ user: McpUser; scopes: string[] } | null> {
    const issuer = `${env.AUTH_API_URL}/api/auth`;
    try {
      const { payload } = await jwtVerify(token, getJwks(issuer), { issuer, audience: env.MCP_URL });
      if (!payload.sub) return null;
      return {
        user: {
          id: payload.sub,
          email: typeof payload.email === 'string' ? payload.email : null,
          name: typeof payload.name === 'string' ? payload.name : null,
          image: typeof payload.picture === 'string' ? payload.picture : null,
        },
        scopes: typeof payload.scope === 'string' ? payload.scope.split(' ').filter(Boolean) : [],
      };
    } catch {
      return null;
    }
  }

  private async exchangeSessionJwt(env: Env, accessToken: string): Promise<string> {
    const request = buildSignedAuthRequest(env, '/api/internal/mcp/session-token', {
      method: 'POST',
      body: JSON.stringify({ accessToken }),
    });
    const res = await sendSignedAuthRequest(request).catch(() => null);
    if (res?.ok) {
      const { token } = (await res.json().catch(() => ({}))) as { token?: string };
      if (token) return token;
    }
    throw new Error(`api-auth session token exchange failed: ${res?.status ?? 'network error'}`);
  }
}
