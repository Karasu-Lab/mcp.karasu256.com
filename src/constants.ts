import { z } from 'zod';

const PRODUCTION_DEFAULTS = {
  AUTH_API_URL: 'https://api-auth.karasu256.com',
  API_URL: 'https://api.karasu256.com',
  CDN_URL: 'https://cdn.karasu256.com',
  MCP_URL: 'https://mcp.karasu256.com/mcp',
};

const PREVIEW_DEFAULTS = {
  AUTH_API_URL: 'https://dev-api-auth.karasu256.com',
  API_URL: 'https://dev-api.karasu256.com',
  CDN_URL: 'https://dev.cdn.karasu256.com',
  MCP_URL: 'https://dev.mcp.karasu256.com/mcp',
};

const LOCAL_DEFAULTS = {
  AUTH_API_URL: 'http://localhost:8790',
  API_URL: 'http://localhost:8789',
  CDN_URL: 'http://localhost:8788',
  MCP_URL: 'http://localhost:8791/mcp',
};

type DomainDefaults = {
  AUTH_API_URL: string;
  API_URL: string;
  CDN_URL: string;
  MCP_URL: string;
};

function domainEnvSchema(defaults: DomainDefaults) {
  return z.object({
    AUTH_API_URL: z.url().default(defaults.AUTH_API_URL),
    API_URL: z.url().default(defaults.API_URL),
    CDN_URL: z.url().default(defaults.CDN_URL),
    MCP_URL: z.url().default(defaults.MCP_URL),
  });
}

export function resolveEnv(raw: Env): Env {
  const defaults =
    raw.APP_ENV === 'local' ? LOCAL_DEFAULTS : raw.APP_ENV === 'preview' ? PREVIEW_DEFAULTS : PRODUCTION_DEFAULTS;
  return { ...raw, ...domainEnvSchema(defaults).parse(raw) };
}
