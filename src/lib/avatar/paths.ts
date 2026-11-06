const AVATAR_PATH_PATTERN = /^u\/profiles\/([^/]+)\/avatar\.png$/;

export function avatarCdnPath(userId: string): string {
  return `u/profiles/${userId}/avatar.png`;
}

export function userIdFromAvatarPath(path: string): string | null {
  return AVATAR_PATH_PATTERN.exec(path)?.[1] ?? null;
}

export function isAvatarCdnUrl(url: string): boolean {
  try {
    return userIdFromAvatarPath(new URL(url).pathname.slice(1)) !== null;
  } catch {
    return false;
  }
}
