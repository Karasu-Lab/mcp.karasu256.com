import { createHash } from 'node:crypto';
import { deleteUploadedImage } from '@karasu-lab/utils/server';
import { fetchIconUploadUrl, fetchSetFirebasePhoto, fetchSetUserImage, fetchUploadStatus, fetchVerifyUpload } from '../api/internal';
import { buildSignedAuthRequest, sendSignedAuthRequest } from '../auth/remote';
import { signUploadIntent, verifyUploadIntent } from './intent';
import { avatarCdnPath } from './paths';

export const MAX_ICON_FILE_BYTES = 5 * 1024 * 1024;
export const ALLOWED_ICON_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

export type IconFileValidationError = 'unsupported_media_type' | 'payload_too_large';

export function validateIconFile(contentType: string, size: number): IconFileValidationError | null {
  if (!ALLOWED_ICON_TYPES.has(contentType)) return 'unsupported_media_type';
  if (size === 0 || size > MAX_ICON_FILE_BYTES) return 'payload_too_large';
  return null;
}

export interface PreparedIconUpload {
  uploadUrl: string;
  intent: string;
}

export async function prepareIconUpload(env: Env, userId: string, bytes: Uint8Array, contentType: string): Promise<PreparedIconUpload> {
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const { uploadUrl, path } = await fetchIconUploadUrl(env, userId, contentType);
  const intent = signUploadIntent(env, { userId, path, sha256, contentType, size: bytes.byteLength });
  return { uploadUrl, intent };
}

export type CompleteIconUploadResult = { ok: true; photoURL: string } | { ok: false; error: 'invalid_intent' | 'upload_verification_failed' };

export async function completeIconUpload(env: Env, sessionJwt: string, userId: string, intentToken: string): Promise<CompleteIconUploadResult> {
  const intent = verifyUploadIntent(env, intentToken, userId);
  if (!intent) return { ok: false, error: 'invalid_intent' };

  const verified = await fetchVerifyUpload(env, sessionJwt, {
    path: intent.path,
    sha256: intent.sha256,
    contentType: intent.contentType,
    size: intent.size,
    uploaderId: userId,
  });
  if (!verified) return { ok: false, error: 'upload_verification_failed' };

  const photoURL = `${env.CDN_URL}/${intent.path}?v=${verified.sha256.slice(0, 16)}`;
  await fetchSetUserImage(env, sessionJwt, userId, photoURL);
  await fetchSetFirebasePhoto(env, sessionJwt, userId, photoURL);
  return { ok: true, photoURL };
}

async function cleanupPreviousIcon(
  env: Env,
  previousPhotoURL: string | undefined,
  nextPhotoURL: string | null,
  cookieHeader: string | null
): Promise<void> {
  if (!cookieHeader || !previousPhotoURL || previousPhotoURL === nextPhotoURL) return;
  await deleteUploadedImage(previousPhotoURL, { imageApiUrl: env.CDN_URL, cookieHeader });
}

export interface ProviderProfile {
  name: string | null;
  email: string | null;
  avatarUrl: string | null;
}

async function getProviderProfile(env: Env, providerId: string, cookieHeader: string | null): Promise<ProviderProfile | null> {
  const request = buildSignedAuthRequest(env, `/api/users/me/providers/${encodeURIComponent(providerId)}/details`, { cookie: cookieHeader });
  const res = await sendSignedAuthRequest(request).catch(() => null);
  if (!res?.ok) return null;
  return (await res.json()) as ProviderProfile;
}

export async function setIconFromProvider(
  env: Env,
  sessionJwt: string,
  userId: string,
  providerId: string,
  cookieHeader: string | null
): Promise<string | null> {
  const profile = await getProviderProfile(env, providerId, cookieHeader);
  if (!profile || !profile.avatarUrl) return null;

  const photo = await fetchSetFirebasePhoto(env, sessionJwt, userId, profile.avatarUrl);
  if (photo.linked) {
    await cleanupPreviousIcon(env, photo.previousPhotoURL ?? undefined, profile.avatarUrl, cookieHeader);
  }
  return profile.avatarUrl;
}

export async function deleteIcon(env: Env, sessionJwt: string, userId: string, cookieHeader: string | null): Promise<void> {
  const photo = await fetchSetFirebasePhoto(env, sessionJwt, userId, null);
  if (photo.linked) {
    await cleanupPreviousIcon(env, photo.previousPhotoURL ?? undefined, null, cookieHeader);
  }
}

export interface VerifiedAvatar {
  body: ReadableStream<Uint8Array>;
  contentType: string;
}

export async function getVerifiedAvatar(env: Env, sessionJwt: string, userId: string, version: string | null): Promise<VerifiedAvatar | null> {
  const path = avatarCdnPath(userId);
  const status = await fetchUploadStatus(env, sessionJwt, path, userId);
  if (!status) return null;

  const source = new URL(`${env.CDN_URL}/${path}`);
  if (version) source.searchParams.set('v', version);

  const res = await fetch(source, { cache: 'no-store' });
  if (!res.ok || !res.body) return null;

  return {
    body: res.body,
    contentType: res.headers.get('content-type') ?? status.contentType ?? 'application/octet-stream',
  };
}
