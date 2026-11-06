import { z } from 'zod';
import { completeIconUpload, deleteIcon, getVerifiedAvatar, prepareIconUpload, setIconFromProvider, validateIconFile } from '../avatar/icon';
import type { McpUser } from './auth';
import { pollDeviceToken, startDeviceAuthorization } from './device';
import { initializeParamsSchema, initializeResultSchema, jsonRpcRequestSchema, toolsCallParamsSchema, type JsonRpcResponse } from './schemas';

export const MCP_PROTOCOL_VERSION = '2025-03-26';

const SUPPORTED_PROTOCOL_VERSIONS = new Set(['2025-03-26', '2025-06-18', '2024-11-05']);

export interface McpContext {
  env: Env;
  user: McpUser | null;
  scopes: string[] | null;
  sessionCookie: string | null;
  getSessionJwt: () => Promise<string>;
}

export interface McpResponse {
  status: number;
  body: JsonRpcResponse | null;
}

function textResult(text: string, isError = false): Record<string, unknown> {
  return { content: [{ type: 'text', text }], isError };
}

function jsonResult(value: unknown): Record<string, unknown> {
  return textResult(JSON.stringify(value));
}

function errorResult(error: unknown): Record<string, unknown> {
  return textResult(error instanceof Error ? error.message : String(error), true);
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function jsonToolResultSchema(valueSchema: z.ZodType): z.ZodType {
  return z.object({
    content: z.tuple([
      z.object({
        type: z.literal('text'),
        text: z.string().refine((text) => {
          try {
            return valueSchema.safeParse(JSON.parse(text)).success;
          } catch {
            return false;
          }
        }),
      }),
    ]),
    isError: z.literal(false),
  });
}

const emptyArgsSchema = z.object({});

const deviceCodeArgsSchema = z.object({
  deviceCode: z.string().min(1).describe('The device_code returned by start_device_authorization.'),
});

const iconFileArgsSchema = z.object({
  contentBase64: z.string().min(1).describe('The icon image file encoded as base64.'),
  contentType: z.enum(['image/jpeg', 'image/png', 'image/webp']),
});

const intentArgsSchema = z.object({
  intent: z.string().min(1).describe('The intent returned by prepare_icon_upload.'),
});

const providerArgsSchema = z.object({
  providerId: z.string().min(1).describe('The linked provider ID, such as google, github, microsoft, xbox or minecraft.'),
});

const getIconArgsSchema = z.object({
  userId: z.string().min(1).optional().describe('The user ID whose icon to fetch. Defaults to the authenticated user.'),
});

const deviceAuthorizationResultSchema = z.object({
  deviceCode: z.string(),
  userCode: z.string(),
  verificationUri: z.string(),
  verificationUriComplete: z.string().nullable(),
  expiresIn: z.number(),
  interval: z.number(),
});

const deviceTokenResultSchema = z.union([
  z.object({
    status: z.literal('authorized'),
    accessToken: z.string(),
    tokenType: z.string(),
    expiresIn: z.number(),
    scope: z.string(),
    refreshToken: z.string().nullable(),
  }),
  z.object({ status: z.literal('pending'), error: z.string(), errorDescription: z.string() }),
]);

const preparedIconUploadSchema = z.object({
  uploadUrl: z.string().min(1),
  intent: z.string().min(1),
});

const photoUrlResultSchema = z.object({ photoURL: z.string().min(1) });

const deletedIconResultSchema = z.object({ photoURL: z.null() });

const getIconResultSchema = z.object({
  content: z.tuple([
    z.object({ type: z.literal('image'), data: z.string().min(1), mimeType: z.string().min(1) }),
    z.object({ type: z.literal('text'), text: z.string().min(1) }),
  ]),
  isError: z.literal(false),
});

export interface ToolDispatch {
  name: string;
  description: string;
  isPublic: boolean;
  requiredScope: string | null;
  invalidArgsMessage: string;
  input(): z.ZodType;
  output(): z.ZodType;
  handle(args: unknown, context: McpContext): Promise<Record<string, unknown>>;
}

interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

function defineTool<I extends z.ZodType>(definition: {
  name: string;
  description: string;
  isPublic?: boolean;
  requiredScope?: string;
  invalidArgsMessage: string;
  inputSchema: I;
  outputSchema: z.ZodType;
  handle: (args: z.infer<I>, context: McpContext) => Promise<Record<string, unknown>>;
}): ToolDispatch {
  return {
    name: definition.name,
    description: definition.description,
    isPublic: definition.isPublic ?? false,
    requiredScope: definition.requiredScope ?? null,
    invalidArgsMessage: definition.invalidArgsMessage,
    input: () => definition.inputSchema,
    output: () => definition.outputSchema,
    handle: definition.handle as ToolDispatch['handle'],
  };
}

const TOOL_DISPATCHES: ToolDispatch[] = [
  defineTool({
    name: 'start_device_authorization',
    description:
      'Starts device sign-in against auth.karasu256.com using the OAuth client ID configured for this MCP server. Returns a user code and verification URL for the user to approve. No authentication is required.',
    isPublic: true,
    invalidArgsMessage: 'start_device_authorization takes no arguments.',
    inputSchema: emptyArgsSchema,
    outputSchema: jsonToolResultSchema(deviceAuthorizationResultSchema),
    handle: async (_args, context) => jsonResult(await startDeviceAuthorization(context.env)),
  }),
  defineTool({
    name: 'poll_device_token',
    description:
      'Polls the device authorization started by start_device_authorization, exchanging the device code at the OAuth token endpoint. While the user has not approved yet, the result reports authorization_pending. Once approved, the result carries the OAuth access token and refresh token issued for this server\'s OAuth client; send the access token as a Bearer token on later MCP requests.',
    isPublic: true,
    invalidArgsMessage: 'poll_device_token requires a deviceCode argument.',
    inputSchema: deviceCodeArgsSchema,
    outputSchema: jsonToolResultSchema(deviceTokenResultSchema),
    handle: async (args, context) => jsonResult(await pollDeviceToken(context.env, args.deviceCode)),
  }),
  defineTool({
    name: 'prepare_icon_upload',
    description:
      'Equivalent of POST /api/user/icon/prepare: validates the icon image, computes its SHA-256 and returns a presigned storage URL plus a signed upload intent. The caller uploads the file to the presigned URL itself. Requires authentication.',
    requiredScope: 'write:users.profile',
    invalidArgsMessage: 'prepare_icon_upload requires contentBase64 and a supported contentType.',
    inputSchema: iconFileArgsSchema,
    outputSchema: jsonToolResultSchema(preparedIconUploadSchema),
    handle: async (args, context) => {
      const user = context.user;
      if (!user) return textResult('Unauthorized', true);
      const bytes = base64ToBytes(args.contentBase64);
      const validationError = validateIconFile(args.contentType, bytes.byteLength);
      if (validationError) return textResult(validationError, true);
      return jsonResult(await prepareIconUpload(context.env, user.id, bytes, args.contentType));
    },
  }),
  defineTool({
    name: 'complete_icon_upload',
    description:
      'Equivalent of POST /api/user/icon/complete: verifies the object uploaded to the presigned URL from prepare_icon_upload and sets it as the profile icon. Requires authentication.',
    requiredScope: 'write:users.profile',
    invalidArgsMessage: 'complete_icon_upload requires an intent argument.',
    inputSchema: intentArgsSchema,
    outputSchema: jsonToolResultSchema(photoUrlResultSchema),
    handle: async (args, context) => {
      const user = context.user;
      if (!user) return textResult('Unauthorized', true);
      const sessionJwt = await context.getSessionJwt();
      const result = await completeIconUpload(context.env, sessionJwt, user.id, args.intent);
      if (!result.ok) return textResult(result.error, true);
      return jsonResult({ photoURL: result.photoURL });
    },
  }),
  defineTool({
    name: 'set_icon_from_provider',
    description: 'Equivalent of PUT /api/user/icon: sets the profile icon to the avatar of one of the linked providers. Requires authentication.',
    requiredScope: 'write:users.profile',
    invalidArgsMessage: 'set_icon_from_provider requires a providerId argument.',
    inputSchema: providerArgsSchema,
    outputSchema: jsonToolResultSchema(photoUrlResultSchema),
    handle: async (args, context) => {
      const user = context.user;
      if (!user) return textResult('Unauthorized', true);
      const sessionJwt = await context.getSessionJwt();
      const photoURL = await setIconFromProvider(context.env, sessionJwt, user.id, args.providerId, context.sessionCookie);
      if (!photoURL) return textResult('Not found: the provider has no avatar available.', true);
      return jsonResult({ photoURL });
    },
  }),
  defineTool({
    name: 'delete_icon',
    description: 'Equivalent of DELETE /api/user/icon: clears the profile icon. Requires authentication.',
    requiredScope: 'write:users.profile',
    invalidArgsMessage: 'delete_icon takes no arguments.',
    inputSchema: emptyArgsSchema,
    outputSchema: jsonToolResultSchema(deletedIconResultSchema),
    handle: async (_args, context) => {
      const user = context.user;
      if (!user) return textResult('Unauthorized', true);
      const sessionJwt = await context.getSessionJwt();
      await deleteIcon(context.env, sessionJwt, user.id, context.sessionCookie);
      return jsonResult({ photoURL: null });
    },
  }),
  defineTool({
    name: 'get_icon',
    description:
      'Equivalent of GET /api/users/{id}/avatar: returns the verified profile icon image. Defaults to the authenticated user when userId is omitted. Requires authentication.',
    requiredScope: 'read:users.profile',
    invalidArgsMessage: 'get_icon takes an optional userId argument.',
    inputSchema: getIconArgsSchema,
    outputSchema: getIconResultSchema,
    handle: async (args, context) => {
      const user = context.user;
      if (!user) return textResult('Unauthorized', true);
      const sessionJwt = await context.getSessionJwt();
      const targetId = args.userId ?? user.id;
      const avatar = await getVerifiedAvatar(context.env, sessionJwt, targetId, null);
      if (!avatar) return textResult('Not found: no verified icon is stored for this user.', true);
      const bytes = new Uint8Array(await new Response(avatar.body).arrayBuffer());
      return {
        content: [
          { type: 'image', data: bytesToBase64(bytes), mimeType: avatar.contentType },
          { type: 'text', text: JSON.stringify({ userId: targetId, contentType: avatar.contentType, size: bytes.byteLength }) },
        ],
        isError: false,
      };
    },
  }),
];

const DEVICE_TOOL_NAMES = new Set(TOOL_DISPATCHES.filter((tool) => tool.isPublic).map((tool) => tool.name));

function toolInputSchema(schema: z.ZodType): Record<string, unknown> {
  const { $schema, ...rest } = z.toJSONSchema(schema);
  return rest;
}

export const MCP_TOOLS: ToolDefinition[] = TOOL_DISPATCHES.map((tool) => ({
  name: tool.name,
  description: tool.description,
  inputSchema: toolInputSchema(tool.input()),
}));

async function callTool(name: string, args: unknown, context: McpContext): Promise<Record<string, unknown>> {
  const tool = TOOL_DISPATCHES.find((candidate) => candidate.name === name);
  if (!tool) return textResult(`Unknown tool: ${name}`, true);

  if (!tool.isPublic) {
    if (!context.user) return textResult('Unauthorized', true);
    if (tool.requiredScope && context.scopes !== null && !context.scopes.includes(tool.requiredScope)) {
      return textResult(`Insufficient scope: ${tool.requiredScope} is required.`, true);
    }
  }

  const parsed = tool.input().safeParse(args ?? {});
  if (!parsed.success) return textResult(tool.invalidArgsMessage, true);

  const result = await tool.handle(parsed.data, context);
  if (result.isError !== true) {
    tool.output().parse(result);
  }
  return result;
}

function rpcResult(id: string | number | null, result: Record<string, unknown>): McpResponse {
  return { status: 200, body: { jsonrpc: '2.0', id, result } };
}

function rpcError(status: number, id: string | number | null, code: number, message: string): McpResponse {
  return { status, body: { jsonrpc: '2.0', id, error: { code, message } } };
}

export async function handleMcpMessage(message: unknown, context: McpContext): Promise<McpResponse> {
  const parsedRequest = jsonRpcRequestSchema.safeParse(message);
  if (!parsedRequest.success) {
    return rpcError(400, null, -32600, 'Invalid Request');
  }
  const request = parsedRequest.data;
  const isNotification = request.id === undefined || request.id === null;
  const id: string | number | null = request.id ?? null;

  if (isNotification) return { status: 202, body: null };

  switch (request.method) {
    case 'initialize': {
      const parsedParams = initializeParamsSchema.safeParse(request.params ?? {});
      const requested = parsedParams.success ? (parsedParams.data.protocolVersion ?? null) : null;
      return rpcResult(
        id,
        initializeResultSchema.parse({
          protocolVersion: requested && SUPPORTED_PROTOCOL_VERSIONS.has(requested) ? requested : MCP_PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'mcp.karasu256.com', version: '0.1.0' },
        })
      );
    }
    case 'ping':
      return rpcResult(id, {});
    case 'tools/list':
      return rpcResult(id, { tools: MCP_TOOLS });
    case 'tools/call': {
      const parsedParams = toolsCallParamsSchema.safeParse(request.params ?? {});
      if (!parsedParams.success) return rpcError(400, id, -32602, 'Invalid params: a tool name is required');
      const params = parsedParams.data;
      if (!TOOL_DISPATCHES.some((tool) => tool.name === params.name)) return rpcError(400, id, -32602, `Unknown tool: ${params.name}`);
      if (!DEVICE_TOOL_NAMES.has(params.name) && !context.user) {
        return rpcError(401, id, -32001, 'Unauthorized');
      }
      try {
        return rpcResult(id, await callTool(params.name, params.arguments ?? {}, context));
      } catch (error) {
        return rpcResult(id, errorResult(error));
      }
    }
    default:
      return rpcError(400, id, -32601, `Method not found: ${request.method}`);
  }
}
