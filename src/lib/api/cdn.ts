import { MissingEnvError, signRequest } from '@karasu-lab/utils/server';
import { z } from 'zod';

const uploadTicketSchema = z.object({ ticket: z.string().min(1) });

export async function fetchSignedUploadUrl(env: Env, bearerJwt: string, path: string): Promise<string> {
  const secret = env.INTERNAL_API_SECRET;
  if (!secret) throw new MissingEnvError('INTERNAL_API_SECRET');

  const url = `${env.CDN_URL}/mcp/upload/ticket`;
  const body = JSON.stringify({ path, ttlSeconds: 300 });
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${bearerJwt}`,
      ...signRequest({ secret, method: 'POST', url, body }),
    },
    body,
    cache: 'no-store',
  });
  if (!res.ok) throw new Error(`cdn.karasu256.com responded ${res.status} for ${res.url}`);

  const { ticket } = uploadTicketSchema.parse(await res.json());
  const uploadUrl = new URL('/upload/signed', env.CDN_URL);
  uploadUrl.searchParams.set('path', path);
  uploadUrl.searchParams.set('ticket', ticket);
  return uploadUrl.toString();
}
