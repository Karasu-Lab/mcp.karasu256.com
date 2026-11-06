import { createHmac, createPrivateKey, createPublicKey, type KeyObject } from 'node:crypto';
import { MissingEnvError } from '@karasu-lab/utils/server';

const ED25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

const keyByMaterial = new Map<string, KeyObject>();

function deriveKeyMaterial(env: Env): string {
  const secret = env.INTERNAL_API_SECRET;
  if (!secret) throw new MissingEnvError('INTERNAL_API_SECRET');
  const seed = createHmac('sha256', secret).update(`app-private-key:${env.APP_ID}`, 'utf8').digest();
  return Buffer.concat([ED25519_PKCS8_PREFIX, seed]).toString('base64');
}

export function appPrivateKey(env: Env): KeyObject {
  const material = env.APP_PRIVATE_KEY ?? deriveKeyMaterial(env);
  const cached = keyByMaterial.get(material);
  if (cached) return cached;
  const key = createPrivateKey({ key: Buffer.from(material, 'base64'), format: 'der', type: 'pkcs8' });
  keyByMaterial.set(material, key);
  return key;
}

export function appPublicKey(env: Env): string {
  const exported = createPublicKey(appPrivateKey(env)).export({ format: 'der', type: 'spki' });
  return (exported as Buffer).toString('base64');
}
