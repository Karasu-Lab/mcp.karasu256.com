import { createHash, generateKeyPairSync, type KeyObject } from 'node:crypto';
import { exportJWK, SignJWT } from 'jose';
import { avatarCdnPath } from '../src/lib/avatar/paths';

export const TEST_USER_ID = 'test-user-1';
export const SESSION_JWT = 'mock-session-jwt';

export interface RecordedCall {
  method: string;
  url: string;
  authorization: string | null;
  body: string | null;
}

interface StoredObject {
  bytes: Uint8Array;
  contentType: string;
}

export interface MockBackend {
  env: Env;
  fetchHandler: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  calls: RecordedCall[];
  signAccessToken: () => Promise<string>;
  seedAvatar: (bytes: Uint8Array, contentType: string) => void;
  storedAvatar: () => StoredObject | undefined;
  failSessionExchange: (status: number | null) => void;
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export async function createMockBackend(): Promise<MockBackend> {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const jwk = await exportJWK(publicKey as KeyObject);
  jwk.kid = 'mock-issuer-key';
  jwk.alg = 'EdDSA';
  jwk.use = 'sig';

  const env = {
    APP_ENV: 'local',
    AUTH_API_URL: 'https://auth.test',
    API_URL: 'https://api.test',
    CDN_URL: 'https://cdn.test',
    MCP_URL: 'https://mcp.test/mcp',
    APP_ID: 'mcp.karasu256.com',
    INTERNAL_API_SECRET: 'test-internal-secret',
  } as Env;

  const issuer = `${env.AUTH_API_URL}/api/auth`;
  const store = new Map<string, StoredObject>();
  const calls: RecordedCall[] = [];
  let sessionExchangeFailure: number | null = null;

  const fetchHandler = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    const rawBody = typeof init?.body === 'string' ? init.body : null;
    calls.push({ method, url: url.href, authorization: headers.get('authorization'), body: rawBody });

    if (method === 'GET' && url.href === `${issuer}/jwks`) {
      return Response.json({ keys: [jwk] });
    }

    if (method === 'GET' && url.href === `${issuer}/oauth2/userinfo`) {
      if (!headers.get('authorization')?.startsWith('Bearer ')) return new Response(null, { status: 401 });
      return Response.json({ sub: TEST_USER_ID, email: 'test@example.com', name: 'Test User', picture: null });
    }

    if (method === 'POST' && url.href === `${env.AUTH_API_URL}/api/internal/mcp/session-token`) {
      if (sessionExchangeFailure !== null) return new Response(null, { status: sessionExchangeFailure });
      const body = JSON.parse(rawBody ?? '{}') as { accessToken?: string };
      if (!body.accessToken) return Response.json({ error: 'invalid_request' }, { status: 400 });
      return Response.json({ token: SESSION_JWT });
    }

    if (method === 'POST' && url.href === `${env.AUTH_API_URL}/api/internal/mcp/icon-upload-url`) {
      const body = JSON.parse(rawBody ?? '{}') as { userId?: string };
      const path = avatarCdnPath(body.userId ?? TEST_USER_ID);
      return Response.json({ uploadUrl: `https://storage.test/put/${path}`, path });
    }

    if (method === 'PUT' && url.origin === 'https://storage.test') {
      const path = url.pathname.replace(/^\/put\//, '');
      const bytes = new Uint8Array(await new Response(init?.body as BodyInit | undefined).arrayBuffer());
      store.set(path, { bytes, contentType: headers.get('content-type') ?? 'application/octet-stream' });
      return new Response(null, { status: 200 });
    }

    if (url.origin === env.API_URL && url.pathname === '/upload/verify') {
      if (headers.get('authorization') !== `Bearer ${SESSION_JWT}`) return new Response(null, { status: 401 });
      if (method === 'GET') {
        const path = url.searchParams.get('path') ?? '';
        const object = store.get(path);
        if (!object) return new Response(null, { status: 404 });
        return Response.json({
          valid: true,
          url: `${env.CDN_URL}/${path}`,
          sha256: sha256Hex(object.bytes),
          contentType: object.contentType,
          size: object.bytes.byteLength,
        });
      }
      if (method === 'POST') {
        const body = JSON.parse(rawBody ?? '{}') as { path?: string; sha256?: string; contentType?: string; size?: number };
        const object = body.path ? store.get(body.path) : undefined;
        if (!object || sha256Hex(object.bytes) !== body.sha256 || object.bytes.byteLength !== body.size) {
          return new Response(null, { status: 422 });
        }
        return Response.json({
          url: `${env.CDN_URL}/${body.path}`,
          sha256: body.sha256,
          contentType: body.contentType,
          size: body.size,
        });
      }
    }

    if (url.origin === env.API_URL && /^\/internal\/users\/[^/]+\/image$/.test(url.pathname) && method === 'POST') {
      if (headers.get('authorization') !== `Bearer ${SESSION_JWT}`) return new Response(null, { status: 401 });
      return Response.json({});
    }

    if (url.origin === env.API_URL && /^\/internal\/users\/[^/]+\/firebase-photo$/.test(url.pathname) && method === 'POST') {
      if (headers.get('authorization') !== `Bearer ${SESSION_JWT}`) return new Response(null, { status: 401 });
      return Response.json({ linked: true, previousPhotoURL: null });
    }

    if (method === 'GET' && url.origin === env.CDN_URL) {
      const path = url.pathname.slice(1);
      const object = store.get(path);
      if (!object) return new Response(null, { status: 404 });
      return new Response(object.bytes, { status: 200, headers: { 'content-type': object.contentType } });
    }

    return new Response(null, { status: 404 });
  };

  const signAccessToken = async (): Promise<string> => {
    return new SignJWT({ scope: 'openid profile read:profile write:profile' })
      .setProtectedHeader({ alg: 'EdDSA', kid: 'mock-issuer-key' })
      .setIssuer(issuer)
      .setAudience(env.MCP_URL)
      .setSubject(TEST_USER_ID)
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(privateKey as KeyObject);
  };

  return {
    env,
    fetchHandler,
    calls,
    signAccessToken,
    seedAvatar: (bytes, contentType) => {
      store.set(avatarCdnPath(TEST_USER_ID), { bytes, contentType });
    },
    storedAvatar: () => store.get(avatarCdnPath(TEST_USER_ID)),
    failSessionExchange: (status) => {
      sessionExchangeFailure = status;
    },
  };
}
