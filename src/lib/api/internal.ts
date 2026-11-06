import { createHash, randomUUID, sign } from 'node:crypto';
import { appPrivateKey } from '../app-key';
import { buildSignedAuthRequest, sendSignedAuthRequest } from '../auth/remote';

const APP_TOKEN_TTL_SECONDS = 120;

function base64Url(data: string | Buffer): string {
  return Buffer.from(data).toString('base64url');
}

function signAppToken(env: Env, userId: string, method: string, url: URL, body: string): string {
  const now = Math.floor(Date.now() / 1000);
  const header = base64Url(JSON.stringify({ alg: 'EdDSA', typ: 'JWT' }));
  const payload = base64Url(
    JSON.stringify({
      iss: env.APP_ID,
      aud: url.origin,
      sub: userId,
      iat: now,
      exp: now + APP_TOKEN_TTL_SECONDS,
      jti: randomUUID(),
      method,
      path: url.pathname,
      bodySha256: createHash('sha256').update(body).digest('hex'),
    })
  );
  const signingInput = `${header}.${payload}`;
  const key = appPrivateKey(env);
  const signature = sign(null, Buffer.from(signingInput), key);
  return `${signingInput}.${base64Url(signature)}`;
}

async function internalFetch(env: Env, sessionJwt: string, path: string, userId: string, init: RequestInit = {}): Promise<Response> {
  const url = new URL(`${env.API_URL}${path}`);
  const method = init.method ?? 'GET';
  const body = typeof init.body === 'string' ? init.body : '';
  return fetch(url, {
    ...init,
    headers: {
      ...init.headers,
      authorization: `Bearer ${sessionJwt}`,
      'x-app-token': signAppToken(env, userId, method, url, body),
    },
    cache: 'no-store',
  });
}

export interface IconUploadUrl {
  uploadUrl: string;
  path: string;
}

export async function fetchIconUploadUrl(env: Env, userId: string, contentType: string): Promise<IconUploadUrl> {
  const request = buildSignedAuthRequest(env, '/api/internal/mcp/icon-upload-url', {
    method: 'POST',
    body: JSON.stringify({ userId, contentType }),
  });
  const res = await sendSignedAuthRequest(request).catch(() => null);
  if (!res?.ok) throw new Error(`api-auth icon upload url request failed: ${res?.status ?? 'network error'}`);
  return (await res.json()) as IconUploadUrl;
}

export interface FirebasePhotoResult {
  linked: boolean;
  previousPhotoURL: string | null;
}

export async function fetchSetFirebasePhoto(env: Env, sessionJwt: string, userId: string, photoURL: string | null): Promise<FirebasePhotoResult> {
  const res = await internalFetch(env, sessionJwt, `/internal/users/${encodeURIComponent(userId)}/firebase-photo`, userId, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ photoURL }),
  });
  if (!res.ok) throw new Error(`api.karasu256.com responded ${res.status} for ${res.url}`);
  return (await res.json()) as FirebasePhotoResult;
}

export async function fetchSetUserImage(env: Env, sessionJwt: string, userId: string, image: string | null): Promise<void> {
  const res = await internalFetch(env, sessionJwt, `/internal/users/${encodeURIComponent(userId)}/image`, userId, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ image }),
  });
  if (!res.ok) throw new Error(`api.karasu256.com responded ${res.status} for ${res.url}`);
}

async function uploadFetch(env: Env, sessionJwt: string, path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${env.API_URL}${path}`, {
    ...init,
    headers: { ...init.headers, authorization: `Bearer ${sessionJwt}` },
    cache: 'no-store',
  });
}

export interface UploadVerifyRequest {
  path: string;
  sha256: string;
  contentType: string;
  size: number;
  uploaderId?: string;
}

export interface VerifiedUpload {
  url: string;
  sha256: string;
  contentType: string;
  size: number;
}

export async function fetchVerifyUpload(env: Env, sessionJwt: string, upload: UploadVerifyRequest): Promise<VerifiedUpload | null> {
  const res = await uploadFetch(env, sessionJwt, '/upload/verify', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(upload),
  });
  if (res.status === 422) return null;
  if (!res.ok) throw new Error(`api.karasu256.com responded ${res.status} for ${res.url}`);
  return (await res.json()) as VerifiedUpload;
}

export interface UploadStatus {
  valid: true;
  url: string;
  sha256?: string;
  contentType?: string;
  size?: number;
}

export async function fetchUploadStatus(env: Env, sessionJwt: string, path: string, uploaderId: string): Promise<UploadStatus | null> {
  const query = new URLSearchParams({ path, uploaderId });
  const res = await uploadFetch(env, sessionJwt, `/upload/verify?${query}`);
  if (res.status === 404 || res.status === 422) return null;
  if (!res.ok) throw new Error(`api.karasu256.com responded ${res.status} for ${res.url}`);
  const status = (await res.json()) as UploadStatus;
  return status.valid ? status : null;
}
