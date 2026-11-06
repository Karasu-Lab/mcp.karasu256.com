import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { fetchSessionJwtForCaller, resolveMcpCaller } from '../src/lib/mcp/auth';
import { handleMcpMessage, type McpContext, type McpResponse } from '../src/lib/mcp/server';
import { createMockBackend, SESSION_JWT, TEST_USER_ID, type MockBackend } from './mock-backend';

const PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8Xw8AAwMCAO+ip1sAAAAASUVORK5CYII=';
const PNG_BYTES = new Uint8Array(Buffer.from(PNG_BASE64, 'base64'));

function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

let backend: MockBackend;

beforeAll(async () => {
  backend = await createMockBackend();
  vi.stubGlobal('fetch', backend.fetchHandler);
});

afterAll(() => {
  vi.unstubAllGlobals();
});

async function buildContext(): Promise<McpContext> {
  const accessToken = await backend.signAccessToken();
  const request = new Request(backend.env.MCP_URL, { headers: { authorization: `Bearer ${accessToken}` } });
  const caller = await resolveMcpCaller(backend.env, request);
  if (!caller) throw new Error('the mock access token did not resolve to a caller');
  let sessionJwtPromise: Promise<string> | null = null;
  return {
    env: backend.env,
    user: caller.user,
    scopes: caller.scopes,
    sessionCookie: null,
    getSessionJwt: () => {
      sessionJwtPromise ??= fetchSessionJwtForCaller(backend.env, caller);
      return sessionJwtPromise;
    },
  };
}

interface ToolResult {
  content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
  isError: boolean;
}

async function callTool(context: McpContext, name: string, args: Record<string, unknown>): Promise<ToolResult> {
  const response: McpResponse = await handleMcpMessage(
    { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } },
    context
  );
  expect(response.status).toBe(200);
  const body = response.body as { result: ToolResult };
  return body.result;
}

function textOf(result: ToolResult): string {
  return result.content.find((item) => item.type === 'text')?.text ?? '';
}

describe('avatar flow over MCP tools with mocked auth services', () => {
  it('reads the current icon through accounts_profile_get_icon', async () => {
    backend.seedAvatar(PNG_BYTES, 'image/png');
    const context = await buildContext();

    const result = await callTool(context, 'accounts_profile_get_icon', {});
    expect(result.isError).toBe(false);

    const image = result.content.find((item) => item.type === 'image');
    expect(image?.mimeType).toBe('image/png');
    expect(sha256Hex(new Uint8Array(Buffer.from(image?.data ?? '', 'base64')))).toBe(sha256Hex(PNG_BYTES));

    const meta = JSON.parse(textOf(result)) as { userId: string; contentType: string; size: number };
    expect(meta.userId).toBe(TEST_USER_ID);
    expect(meta.contentType).toBe('image/png');
    expect(meta.size).toBe(PNG_BYTES.byteLength);

    const exchange = backend.calls.find((call) => call.url.endsWith('/api/internal/mcp/session-token'));
    expect(exchange).toBeDefined();
    const statusCall = backend.calls.find((call) => call.url.includes('/upload/verify') && call.method === 'GET');
    expect(statusCall?.authorization).toBe(`Bearer ${SESSION_JWT}`);
  });

  it('writes the downloaded icon back with prepare, upload and complete', async () => {
    backend.seedAvatar(PNG_BYTES, 'image/png');
    const context = await buildContext();

    const downloaded = await callTool(context, 'accounts_profile_get_icon', {});
    expect(downloaded.isError).toBe(false);
    const downloadedImage = downloaded.content.find((item) => item.type === 'image');
    const downloadedBytes = new Uint8Array(Buffer.from(downloadedImage?.data ?? '', 'base64'));
    expect(sha256Hex(downloadedBytes)).toBe(sha256Hex(PNG_BYTES));

    const prepared = await callTool(context, 'accounts_profile_prepare_icon_upload', {
      contentBase64: Buffer.from(downloadedBytes).toString('base64'),
      contentType: downloadedImage?.mimeType ?? 'image/png',
    });
    expect(prepared.isError).toBe(false);
    const { uploadUrl, intent } = JSON.parse(textOf(prepared)) as { uploadUrl: string; intent: string };
    expect(uploadUrl).toBeTruthy();
    expect(intent).toBeTruthy();

    const put = await fetch(uploadUrl, {
      method: 'PUT',
      headers: { 'content-type': downloadedImage?.mimeType ?? 'image/png' },
      body: downloadedBytes,
    });
    expect(put.status).toBe(200);

    const completed = await callTool(context, 'accounts_profile_flow_complete_icon_upload', { intent });
    expect(completed.isError).toBe(false);
    const { photoURL } = JSON.parse(textOf(completed)) as { photoURL: string };
    expect(photoURL.startsWith(`${backend.env.CDN_URL}/u/profiles/${TEST_USER_ID}/avatar.png?v=`)).toBe(true);

    const reread = await callTool(context, 'accounts_profile_get_icon', {});
    expect(reread.isError).toBe(false);
    const rereadImage = reread.content.find((item) => item.type === 'image');
    expect(sha256Hex(new Uint8Array(Buffer.from(rereadImage?.data ?? '', 'base64')))).toBe(sha256Hex(PNG_BYTES));
  });

  it('surfaces a session exchange failure as a tool error', async () => {
    backend.failSessionExchange(500);
    try {
      const context = await buildContext();
      const result = await callTool(context, 'accounts_profile_get_icon', {});
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain('api-auth session token exchange failed: 500');
    } finally {
      backend.failSessionExchange(null);
    }
  });
});
