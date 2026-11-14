import { createHash } from 'node:crypto';
import { z } from 'zod';
import { deleteUploadedImage } from '@karasu-lab/utils/server';
import { fetchAvatarUploadUrl, fetchSetFirebasePhoto, fetchSetUserImage, fetchUploadStatus, fetchVerifyUpload } from '../lib/api/internal';
import { buildSignedAuthRequest, sendSignedAuthRequest } from '../lib/auth/remote';
import { signUploadIntent, verifyUploadIntent } from '../lib/avatar/intent';
import { defineTool, jsonResult, jsonToolResultSchema, textResult, type ToolDispatch } from '../lib/mcp/server';

const photoUrlResultSchema = z.object({ photoURL: z.string().min(1) });

export function avatarPath(userId: string): string {
  return `u/profiles/${userId}/avatars/default/avatar.png`;
}

async function cleanupPreviousIcon(env: Env, previousPhotoURL: string | null, nextPhotoURL: string | null, cookieHeader: string | null) {
  if (!cookieHeader || !previousPhotoURL || previousPhotoURL === nextPhotoURL) return;
  await deleteUploadedImage(previousPhotoURL, { imageApiUrl: env.CDN_URL, cookieHeader });
}

async function providerAvatarUrl(env: Env, providerId: string, cookieHeader: string | null): Promise<string | null> {
  const request = buildSignedAuthRequest(env, `/api/users/me/providers/${encodeURIComponent(providerId)}/details`, { cookie: cookieHeader });
  const res = await sendSignedAuthRequest(request).catch(() => null);
  if (!res?.ok) return null;
  return z.object({ avatarUrl: z.string().nullable() }).parse(await res.json()).avatarUrl;
}

export function avatarCommands(): ToolDispatch[] {
  return [
    defineTool({
      name: 'accounts_profile_prepare_icon_upload',
      description:
        'Equivalent of POST /api/user/icon/prepare: returns a presigned storage URL plus a signed upload intent for the icon. Describe the image either by contentBase64, or by the sha256 and size of a local file, in which case the caller uploads the file with an HTTP PUT (with the same content-type) to the presigned URL itself, e.g. curl -X PUT -H "content-type: <contentType>" --data-binary @<file> <uploadUrl>. Requires authentication.',
      requiredScope: 'write:users.profile',
      invalidArgsMessage:
        'accounts_profile_prepare_icon_upload requires a supported contentType and either contentBase64 or both sha256 and size.',
      inputSchema: z
        .object({
          contentBase64: z.string().min(1).optional().describe('The icon image file encoded as base64.'),
          sha256: z
            .string()
            .regex(/^[0-9a-fA-F]{64}$/)
            .optional()
            .describe('The hex SHA-256 of the icon image file. Used together with size instead of contentBase64.'),
          size: z.number().int().positive().optional().describe('The byte size of the icon image file. Used together with sha256 instead of contentBase64.'),
          contentType: z.enum(['image/jpeg', 'image/png', 'image/webp']),
        })
        .refine((args) => args.contentBase64 !== undefined || (args.sha256 !== undefined && args.size !== undefined)),
      outputSchema: jsonToolResultSchema(z.object({ uploadUrl: z.string().min(1), intent: z.string().min(1) })),
      handle: async (args, context) => {
        const user = context.user;
        if (!user) return textResult('Unauthorized', true);
        let sha256: string;
        let size: number;
        if (args.contentBase64 !== undefined) {
          const bytes = Buffer.from(args.contentBase64, 'base64');
          sha256 = createHash('sha256').update(bytes).digest('hex');
          size = bytes.byteLength;
        } else {
          sha256 = (args.sha256 as string).toLowerCase();
          size = args.size as number;
        }
        if (size === 0 || size > 5 * 1024 * 1024) return textResult('payload_too_large', true);
        const { uploadUrl, path } = await fetchAvatarUploadUrl(context.env, await context.getSessionJwt(), user.id, args.contentType);
        const intent = signUploadIntent(context.env, { userId: user.id, path, sha256, contentType: args.contentType, size });
        return jsonResult({ uploadUrl, intent });
      },
    }),
    defineTool({
      name: 'accounts_profile_flow_complete_icon_upload',
      description:
        'Equivalent of POST /api/user/icon/complete: verifies the object uploaded to the presigned URL from accounts_profile_prepare_icon_upload and sets it as the profile icon. Requires authentication.',
      requiredScope: 'write:users.profile',
      invalidArgsMessage: 'accounts_profile_flow_complete_icon_upload requires an intent argument.',
      inputSchema: z.object({ intent: z.string().min(1).describe('The intent returned by accounts_profile_prepare_icon_upload.') }),
      outputSchema: jsonToolResultSchema(photoUrlResultSchema),
      handle: async (args, context) => {
        const user = context.user;
        if (!user) return textResult('Unauthorized', true);
        const intent = verifyUploadIntent(context.env, args.intent, user.id);
        if (!intent) return textResult('invalid_intent', true);
        const sessionJwt = await context.getSessionJwt();
        const verified = await fetchVerifyUpload(context.env, sessionJwt, {
          path: intent.path,
          sha256: intent.sha256,
          contentType: intent.contentType,
          size: intent.size,
          uploaderId: user.id,
        });
        if (!verified) return textResult('upload_verification_failed', true);
        const photoURL = `${context.env.CDN_URL}/${intent.path}?v=${verified.sha256.slice(0, 16)}`;
        await fetchSetUserImage(context.env, sessionJwt, user.id, photoURL);
        await fetchSetFirebasePhoto(context.env, sessionJwt, user.id, photoURL);
        return jsonResult({ photoURL });
      },
    }),
    defineTool({
      name: 'accounts_profile_flow_set_icon_from_provider',
      description: 'Equivalent of PUT /api/user/icon: sets the profile icon to the avatar of one of the linked providers. Requires authentication.',
      requiredScope: 'write:users.profile',
      invalidArgsMessage: 'accounts_profile_flow_set_icon_from_provider requires a providerId argument.',
      inputSchema: z.object({
        providerId: z.string().min(1).describe('The linked provider ID, such as google, github, microsoft, xbox or minecraft.'),
      }),
      outputSchema: jsonToolResultSchema(photoUrlResultSchema),
      handle: async (args, context) => {
        const user = context.user;
        if (!user) return textResult('Unauthorized', true);
        const photoURL = await providerAvatarUrl(context.env, args.providerId, context.sessionCookie);
        if (!photoURL) return textResult('Not found: the provider has no avatar available.', true);
        const photo = await fetchSetFirebasePhoto(context.env, await context.getSessionJwt(), user.id, photoURL);
        if (photo.linked) await cleanupPreviousIcon(context.env, photo.previousPhotoURL, photoURL, context.sessionCookie);
        return jsonResult({ photoURL });
      },
    }),
    defineTool({
      name: 'accounts_profile_flow_delete_icon',
      description: 'Equivalent of DELETE /api/user/icon: clears the profile icon. Requires authentication.',
      requiredScope: 'write:users.profile',
      invalidArgsMessage: 'accounts_profile_flow_delete_icon takes no arguments.',
      inputSchema: z.object({}),
      outputSchema: jsonToolResultSchema(z.object({ photoURL: z.null() })),
      handle: async (_args, context) => {
        const user = context.user;
        if (!user) return textResult('Unauthorized', true);
        const photo = await fetchSetFirebasePhoto(context.env, await context.getSessionJwt(), user.id, null);
        if (photo.linked) await cleanupPreviousIcon(context.env, photo.previousPhotoURL, null, context.sessionCookie);
        return jsonResult({ photoURL: null });
      },
    }),
    defineTool({
      name: 'accounts_profile_get_icon',
      description:
        'Equivalent of GET /api/users/{id}/avatar: returns the verified profile icon image. Defaults to the authenticated user when userId is omitted. Requires authentication.',
      requiredScope: 'read:users.profile',
      invalidArgsMessage: 'accounts_profile_get_icon takes an optional userId argument.',
      inputSchema: z.object({
        userId: z.string().min(1).optional().describe('The user ID whose icon to fetch. Defaults to the authenticated user.'),
      }),
      outputSchema: z.object({
        content: z.tuple([
          z.object({ type: z.literal('image'), data: z.string().min(1), mimeType: z.string().min(1) }),
          z.object({ type: z.literal('text'), text: z.string().min(1) }),
        ]),
        isError: z.literal(false),
      }),
      handle: async (args, context) => {
        const user = context.user;
        if (!user) return textResult('Unauthorized', true);
        const targetId = args.userId ?? user.id;
        const path = avatarPath(targetId);
        const status = await fetchUploadStatus(context.env, await context.getSessionJwt(), path, targetId);
        if (!status) return textResult('Not found: no verified icon is stored for this user.', true);
        const res = await fetch(`${context.env.CDN_URL}/${path}`, { cache: 'no-store' });
        if (!res.ok) return textResult('Not found: no verified icon is stored for this user.', true);
        const bytes = new Uint8Array(await res.arrayBuffer());
        const contentType = res.headers.get('content-type') ?? status.contentType ?? 'application/octet-stream';
        return {
          content: [
            { type: 'image', data: Buffer.from(bytes).toString('base64'), mimeType: contentType },
            { type: 'text', text: JSON.stringify({ userId: targetId, contentType, size: bytes.byteLength }) },
          ],
          isError: false,
        };
      },
    }),
  ];
}
