import { z } from 'zod';

export const rpcIdSchema = z.union([z.string(), z.number(), z.null()]);

export const jsonRpcRequestSchema = z.looseObject({
  id: rpcIdSchema.optional(),
  method: z.string().min(1),
  params: z.unknown().optional(),
});

export const initializeParamsSchema = z.object({
  protocolVersion: z.string().min(1).optional(),
});

export const toolsCallParamsSchema = z.object({
  name: z.string().min(1),
  arguments: z.record(z.string(), z.unknown()).optional(),
});

export const initializeResultSchema = z.object({
  protocolVersion: z.string().min(1),
  capabilities: z.object({ tools: z.object({ listChanged: z.boolean() }) }),
  serverInfo: z.object({ name: z.string().min(1), version: z.string().min(1) }),
});

export const rpcErrorSchema = z.object({
  code: z.number().int(),
  message: z.string(),
});

export const jsonRpcResponseSchema = z.union([
  z.object({ jsonrpc: z.literal('2.0'), id: rpcIdSchema, result: z.unknown() }),
  z.object({ jsonrpc: z.literal('2.0'), id: rpcIdSchema, error: rpcErrorSchema }),
]);

export type JsonRpcResponse = z.infer<typeof jsonRpcResponseSchema>;

export const appPublicKeyResponseSchema = z.object({
  appId: z.string().min(1),
  publicKey: z.string().min(1),
});
