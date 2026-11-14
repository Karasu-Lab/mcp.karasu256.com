import { z } from 'zod';
import type { McpUser } from './auth/common';
import { initializeParamsSchema, initializeResultSchema, jsonRpcRequestSchema, toolsCallParamsSchema, type JsonRpcResponse } from './schemas';

export const MCP_PROTOCOL_VERSION = '2025-03-26';

const SUPPORTED_PROTOCOL_VERSIONS = new Set(['2025-03-26', '2025-06-18', '2024-11-05']);

export interface McpContext {
  env: Env;
  user: McpUser | null;
  scopes: string[] | null;
  sessionCookie: string | null;
  getSessionJwt: () => Promise<string>;
  tools: ToolDispatch[];
}

export interface McpResponse {
  status: number;
  body: JsonRpcResponse | null;
}

export function textResult(text: string, isError = false): Record<string, unknown> {
  return { content: [{ type: 'text', text }], isError };
}

export function jsonResult(value: unknown): Record<string, unknown> {
  return textResult(JSON.stringify(value));
}

function errorResult(error: unknown): Record<string, unknown> {
  return textResult(error instanceof Error ? error.message : String(error), true);
}

export function jsonToolResultSchema(valueSchema: z.ZodType): z.ZodType {
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

export function defineTool<I extends z.ZodType>(definition: {
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

function toolInputSchema(schema: z.ZodType): Record<string, unknown> {
  const { $schema, ...rest } = z.toJSONSchema(schema);
  return rest;
}

function toolDefinition(tool: ToolDispatch): ToolDefinition {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: toolInputSchema(tool.input()),
  };
}

function isToolUsable(tool: ToolDispatch, context: McpContext): boolean {
  if (tool.isPublic) return true;
  if (!context.user) return false;
  if (!tool.requiredScope) return true;
  return context.scopes === null || context.scopes.includes(tool.requiredScope);
}

function listUsableTools(context: McpContext): ToolDefinition[] {
  return context.tools.filter((tool) => isToolUsable(tool, context)).map(toolDefinition);
}

async function callTool(tool: ToolDispatch, args: unknown, context: McpContext): Promise<Record<string, unknown>> {
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
      return rpcResult(id, { tools: listUsableTools(context) });
    case 'tools/call': {
      const parsedParams = toolsCallParamsSchema.safeParse(request.params ?? {});
      if (!parsedParams.success) return rpcError(400, id, -32602, 'Invalid params: a tool name is required');
      const params = parsedParams.data;
      const tool = context.tools.find((candidate) => candidate.name === params.name);
      if (!tool) return rpcError(400, id, -32602, `Unknown tool: ${params.name}`);
      if (!tool.isPublic && !context.user) {
        return rpcError(401, id, -32001, 'Unauthorized');
      }
      try {
        return rpcResult(id, await callTool(tool, params.arguments ?? {}, context));
      } catch (error) {
        return rpcResult(id, errorResult(error));
      }
    }
    default:
      return rpcError(400, id, -32601, `Method not found: ${request.method}`);
  }
}
