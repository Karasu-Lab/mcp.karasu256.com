import { createPublicKey, sign, verify, type KeyObject } from 'node:crypto';
import { z } from 'zod';
import { appPrivateKey } from '../app-key';

const INTENT_TTL_SECONDS = 600;

const intentSchema = z.object({
  userId: z.string().min(1),
  path: z.string().min(1),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  contentType: z.string().min(1),
  size: z.number().int().positive(),
  exp: z.number().int(),
});

export type UploadIntent = z.infer<typeof intentSchema>;

function privateKey(env: Env): KeyObject {
  return appPrivateKey(env);
}

export function signUploadIntent(env: Env, intent: Omit<UploadIntent, 'exp'>): string {
  const payload: UploadIntent = { ...intent, exp: Math.floor(Date.now() / 1000) + INTENT_TTL_SECONDS };
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = sign(null, Buffer.from(encoded), privateKey(env));
  return `${encoded}.${signature.toString('base64url')}`;
}

export function verifyUploadIntent(env: Env, token: string, userId: string): UploadIntent | null {
  const [encoded, signature, ...rest] = token.split('.');
  if (!encoded || !signature || rest.length > 0) return null;

  const publicKey = createPublicKey(privateKey(env));
  if (!verify(null, Buffer.from(encoded), publicKey, Buffer.from(signature, 'base64url'))) return null;

  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  const parsed = intentSchema.safeParse(decoded);
  if (!parsed.success) return null;
  if (parsed.data.userId !== userId) return null;
  if (parsed.data.exp < Math.floor(Date.now() / 1000)) return null;
  return parsed.data;
}
