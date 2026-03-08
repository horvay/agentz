export const FOLDER_ACCENT_PALETTE = [
  { hue: 194, saturation: 92, lightness: 66 },
  { hue: 147, saturation: 78, lightness: 58 },
  { hue: 31, saturation: 95, lightness: 64 },
  { hue: 331, saturation: 88, lightness: 68 },
  { hue: 264, saturation: 86, lightness: 71 },
  { hue: 84, saturation: 84, lightness: 60 },
  { hue: 221, saturation: 90, lightness: 66 },
  { hue: 54, saturation: 96, lightness: 68 },
  { hue: 3, saturation: 90, lightness: 66 },
  { hue: 171, saturation: 82, lightness: 56 },
] as const;

export function folderAccentKey(cwd?: string): string {
  return cwd && cwd.length > 0 ? cwd : "unknown-folder";
}

export function colorHash(input: string): number {
  let hash = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function hueDistance(a: number, b: number): number {
  const raw = Math.abs(a - b) % 360;
  return Math.min(raw, 360 - raw);
}

export function resolveFolderAccentAssignments(
  currentFolders: string[],
  previousLiveAssignments: Record<string, number>,
  historicalAssignments: Record<string, number>,
): {
  liveAssignments: Record<string, number>;
  historicalAssignments: Record<string, number>;
} {
  const uniqueFolders = Array.from(new Set(currentFolders));

  const liveAssignments: Record<string, number> = {};
  const usedSlots = new Set<number>();

  for (const folder of uniqueFolders) {
    const existing = previousLiveAssignments[folder];
    if (typeof existing !== "number") continue;
    liveAssignments[folder] = existing;
    usedSlots.add(existing);
  }

  for (const folder of uniqueFolders) {
    if (typeof liveAssignments[folder] === "number") continue;

    const historical = historicalAssignments[folder];
    if (typeof historical === "number" && !usedSlots.has(historical)) {
      liveAssignments[folder] = historical;
      usedSlots.add(historical);
      continue;
    }

    const preferred = colorHash(folder) % FOLDER_ACCENT_PALETTE.length;
    let selected = preferred;

    const availableSlots = Array.from({ length: FOLDER_ACCENT_PALETTE.length }, (_, index) => index).filter(
      (index) => !usedSlots.has(index),
    );

    if (availableSlots.length > 0) {
      let bestScore = -1;
      let bestTieBreaker = Number.POSITIVE_INFINITY;
      for (const candidate of availableSlots) {
        const candidateHue = FOLDER_ACCENT_PALETTE[candidate].hue;
        let minDistance = Number.POSITIVE_INFINITY;
        for (const used of usedSlots) {
          minDistance = Math.min(minDistance, hueDistance(candidateHue, FOLDER_ACCENT_PALETTE[used].hue));
        }
        if (usedSlots.size === 0) minDistance = 360;
        const tieBreaker = hueDistance(candidateHue, FOLDER_ACCENT_PALETTE[preferred].hue);
        if (
          minDistance > bestScore ||
          (minDistance === bestScore && tieBreaker < bestTieBreaker)
        ) {
          bestScore = minDistance;
          bestTieBreaker = tieBreaker;
          selected = candidate;
        }
      }
    }

    liveAssignments[folder] = selected;
    historicalAssignments[folder] = selected;
    usedSlots.add(selected);
  }

  for (const [folder, slot] of Object.entries(liveAssignments)) {
    historicalAssignments[folder] = slot;
  }

  return { liveAssignments, historicalAssignments };
}
