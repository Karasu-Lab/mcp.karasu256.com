# mcp.karasu256.com

The MCP server for Karasu Lab, running as a Cloudflare Worker built on ElysiaJS. It serves the Streamable HTTP MCP endpoint at `/mcp` with the profile icon tools and the device authorization tools, and centralizes MCP authentication: an OAuth access token issued by Karasu-Lab/api-auth.karasu256.com is verified against the authorization server's JWKS, its granted scopes are enforced per tool, and tool execution runs with the session the token belongs to. This worker holds neither the database URL nor the storage keys: the session JWT exchange and the presigned upload URL issuance are delegated to api-auth.karasu256.com, which owns both, through its signed internal endpoints. Split out of Karasu-Lab/accounts.karasu256.com, which no longer defines an MCP server.

## Required environment variables

The deploy workflow (`.github/workflows/mcp-deploy.yml`) uses Karasu-Lab/WorkersDeploy and syncs the following worker secrets on every deploy. Values are never committed to the repository.

| Name | Used for |
| --- | --- |
| `INTERNAL_API_SECRET` | Shared secret for signed internal API calls to api-auth.karasu256.com, and the seed the app private key is derived from when no key is configured |

`MCP_OAUTH_CLIENT_ID` is a public identifier, not a secret: it is the device-type OAuth client ID the device authorization tools act for, configured as a GitHub environment variable and synced to the worker with the other variables on every deploy.

`APP_PRIVATE_KEY` is optional and not synced by the workflow. When it is not set, the worker creates its Ed25519 app private key itself by deriving it deterministically from `INTERNAL_API_SECRET` scoped to `APP_ID`, so every instance uses the same key without any key material being provisioned. The matching public key (base64 SPKI, the value to register as the app public key on api.karasu256.com) is published at `GET /.well-known/app-public-key`. Setting `APP_PRIVATE_KEY` (base64 PKCS#8) pins a specific key instead, which changes the published public key.
