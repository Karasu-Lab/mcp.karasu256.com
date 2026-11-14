import { ClaudeCommands } from '../../commands';

export function resourceMetadataPath(env: Env): string {
  return `/.well-known/oauth-protected-resource${new URL(env.MCP_URL).pathname}`;
}

export function bearerChallenge(env: Env): string {
  return `Bearer resource_metadata="${new URL(env.MCP_URL).origin}${resourceMetadataPath(env)}"`;
}

export function protectedResourceMetadata(env: Env) {
  const toolScopes = new ClaudeCommands()
    .list()
    .map((tool) => tool.requiredScope)
    .filter((scope): scope is string => scope !== null);
  return {
    resource: env.MCP_URL,
    authorization_servers: [`${env.AUTH_API_URL}/api/auth`],
    scopes_supported: [...new Set(['openid', 'offline_access', ...toolScopes])],
    bearer_methods_supported: ['header'],
  };
}
