import { z } from 'zod';

const envSchema = z.object({
  AUTH_API_URL: z.url(),
  API_URL: z.url(),
  CDN_URL: z.url(),
  MCP_URL: z.url(),
});

export function resolveEnv(raw: Env): Env {
  return { ...raw, ...envSchema.parse(raw) };
}
