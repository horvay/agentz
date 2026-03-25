import type { AvatarId } from "./avatarCatalog";

function hashPaneId(id: string): number {
  let hash = 2166136261;
  for (let index = 0; index < id.length; index += 1) {
    hash ^= id.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export function pickDeterministicAvatar(
  paneId: string,
  avatarIds: AvatarId[],
  used: Set<AvatarId>,
): AvatarId | null {
  const available = avatarIds.filter((id) => !used.has(id));
  if (available.length === 0) return null;
  return available[hashPaneId(paneId) % available.length];
}

export function assignPaneAvatars(
  paneIds: string[],
  avatarIds: AvatarId[],
  previous: Record<string, AvatarId> = {},
): Record<string, AvatarId> {
  const validAvatarIds = new Set(avatarIds);
  const used = new Set<AvatarId>();
  const next: Record<string, AvatarId> = {};

  for (const paneId of paneIds) {
    const avatarId = previous[paneId];
    if (!avatarId || used.has(avatarId) || !validAvatarIds.has(avatarId)) continue;
    next[paneId] = avatarId;
    used.add(avatarId);
  }

  for (const paneId of paneIds) {
    if (next[paneId]) continue;
    const avatarId = pickDeterministicAvatar(paneId, avatarIds, used);
    if (!avatarId) continue;
    next[paneId] = avatarId;
    used.add(avatarId);
  }

  return next;
}
