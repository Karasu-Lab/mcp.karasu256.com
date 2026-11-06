import { MissingEnvError, signRequest } from '@karasu-lab/utils/server';

export interface SignedAuthRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string;
}

export interface SignedAuthRequestOptions {
  method?: string;
  body?: string;
  cookie?: string | null;
}

export function buildSignedAuthRequest(env: Env, path: string, options: SignedAuthRequestOptions = {}): SignedAuthRequest {
  const secret = env.INTERNAL_API_SECRET;
  if (!secret) throw new MissingEnvError('INTERNAL_API_SECRET');

  const method = options.method ?? 'GET';
  const url = `${env.AUTH_API_URL}${path}`;

  return {
    method,
    url,
    body: options.body,
    headers: {
      ...(options.body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(options.cookie ? { cookie: options.cookie } : {}),
      ...signRequest({ secret, method, url, body: options.body }),
    },
  };
}

export function sendSignedAuthRequest(request: SignedAuthRequest): Promise<Response> {
  return fetch(request.url, { method: request.method, headers: request.headers, body: request.body, cache: 'no-store' });
}
