import { z } from 'zod';
import { pollDeviceToken, startDeviceAuthorization } from '../lib/mcp/device';
import { defineTool, jsonResult, jsonToolResultSchema, type ToolDispatch } from '../lib/mcp/server';

export function deviceCommands(): ToolDispatch[] {
  return [
    defineTool({
      name: 'accounts_auth_start_device_authorization',
      description:
        'Starts device sign-in against auth.karasu256.com using the OAuth client ID configured for this MCP server. Returns a user code and verification URL for the user to approve. No authentication is required.',
      isPublic: true,
      invalidArgsMessage: 'accounts_auth_start_device_authorization takes no arguments.',
      inputSchema: z.object({}),
      outputSchema: jsonToolResultSchema(
        z.object({
          deviceCode: z.string(),
          userCode: z.string(),
          verificationUri: z.string(),
          verificationUriComplete: z.string().nullable(),
          expiresIn: z.number(),
          interval: z.number(),
        })
      ),
      handle: async (_args, context) => jsonResult(await startDeviceAuthorization(context.env)),
    }),
    defineTool({
      name: 'accounts_auth_poll_device_token',
      description:
        "Polls the device authorization started by accounts_auth_start_device_authorization, exchanging the device code at the OAuth token endpoint. While the user has not approved yet, the result reports authorization_pending. Once approved, the result carries the OAuth access token and refresh token issued for this server's OAuth client; send the access token as a Bearer token on later MCP requests.",
      isPublic: true,
      invalidArgsMessage: 'accounts_auth_poll_device_token requires a deviceCode argument.',
      inputSchema: z.object({
        deviceCode: z.string().min(1).describe('The device_code returned by accounts_auth_start_device_authorization.'),
      }),
      outputSchema: jsonToolResultSchema(
        z.union([
          z.object({
            status: z.literal('authorized'),
            accessToken: z.string(),
            tokenType: z.string(),
            expiresIn: z.number(),
            scope: z.string(),
            refreshToken: z.string().nullable(),
          }),
          z.object({ status: z.literal('pending'), error: z.string(), errorDescription: z.string() }),
        ])
      ),
      handle: async (args, context) => jsonResult(await pollDeviceToken(context.env, args.deviceCode)),
    }),
  ];
}
