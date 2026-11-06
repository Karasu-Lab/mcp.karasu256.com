# mcp.karasu256.com

The MCP server for Karasu Lab, running as a Cloudflare Worker built on ElysiaJS. It serves the Streamable HTTP MCP endpoint at `/mcp` with the profile icon tools and the device authorization tools, and centralizes MCP authentication: an OAuth access token issued by Karasu-Lab/api-auth.karasu256.com is verified against the authorization server's JWKS, its granted scopes are enforced per tool, and tool execution runs with the session the token belongs to. This worker holds neither the database URL nor the storage keys: the session JWT exchange and the presigned upload URL issuance are delegated to api-auth.karasu256.com, which owns both, through its signed internal endpoints. Split out of Karasu-Lab/accounts.karasu256.com, which no longer defines an MCP server.

## Required environment variables

The deploy workflow (`.github/workflows/mcp-deploy.yml`) uses Karasu-Lab/WorkersDeploy and syncs the following worker secrets on every deploy. Values are never committed to the repository.

| Name | Used for |
| --- | --- |
| `INTERNAL_API_SECRET` | Shared secret for signed internal API calls to api-auth.karasu256.com |
| `APP_PRIVATE_KEY` | This app's Ed25519 private key for application tokens to api.karasu256.com and for signing upload intents |
| `MCP_OAUTH_CLIENT_ID` | The device-type OAuth client ID the device authorization tools act for |
