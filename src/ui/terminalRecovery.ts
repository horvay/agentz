export interface RecoveredTerminalLayout {
  paneIds: string[];
  backgroundTerminalIds: Record<string, string[]>;
  visibleSessionIds: Record<string, string>;
}

function paneOrdinal(id: string): number | null {
  const match = /^term-(\d+)$/.exec(id);
  if (!match) return null;
  const ordinal = Number(match[1]);
  return Number.isFinite(ordinal) ? ordinal : null;
}

function comparePaneIds(a: string, b: string): number {
  const aOrdinal = paneOrdinal(a);
  const bOrdinal = paneOrdinal(b);
  if (aOrdinal != null && bOrdinal != null) return aOrdinal - bOrdinal;
  if (aOrdinal != null) return -1;
  if (bOrdinal != null) return 1;
  return a.localeCompare(b, undefined, { numeric: true });
}

export function recoverTerminalLayout(sessionIds: string[]): RecoveredTerminalLayout {
  const paneIds = new Set<string>();
  const frontIds = new Set<string>();
  const backgroundTerminalIds: Record<string, string[]> = {};
  const visibleSessionIds: Record<string, string> = {};

  const parseBackgroundId = (id: string): { paneId: string; ordinal: number } | null => {
    const match = /^(term-\d+)-bg(?:-(\d+))?$/.exec(id);
    if (!match) return null;
    const paneId = match[1];
    if (!paneId) return null;
    const ordinal = match[2] ? Number(match[2]) : 1;
    return Number.isFinite(ordinal) ? { paneId, ordinal } : null;
  };

  sessionIds.forEach((id) => {
    if (parseBackgroundId(id)) return;
    frontIds.add(id);
    paneIds.add(id);
  });

  sessionIds.forEach((id) => {
    const parsed = parseBackgroundId(id);
    if (!parsed) return;
    const { paneId } = parsed;
    paneIds.add(paneId);
    backgroundTerminalIds[paneId] = [...(backgroundTerminalIds[paneId] ?? []), id];
  });

  for (const [paneId, ids] of Object.entries(backgroundTerminalIds)) {
    backgroundTerminalIds[paneId] = ids.sort((a, b) => {
      const aOrdinal = parseBackgroundId(a)?.ordinal ?? 1;
      const bOrdinal = parseBackgroundId(b)?.ordinal ?? 1;
      return aOrdinal - bOrdinal;
    });
    if (!frontIds.has(paneId)) {
      const firstBackgroundId = backgroundTerminalIds[paneId][0];
      if (firstBackgroundId) {
        visibleSessionIds[paneId] = firstBackgroundId;
      }
    }
  }

  return {
    paneIds: [...paneIds].sort(comparePaneIds),
    backgroundTerminalIds,
    visibleSessionIds,
  };
}
