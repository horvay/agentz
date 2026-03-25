const BACKGROUND_TERMINAL_SUFFIX = "-bg";

export interface RecoveredTerminalLayout {
  paneIds: string[];
  backgroundTerminalIds: Record<string, string>;
  backgroundTerminalVisible: Record<string, boolean>;
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
  const backgroundTerminalIds: Record<string, string> = {};
  const backgroundTerminalVisible: Record<string, boolean> = {};

  sessionIds.forEach((id) => {
    if (id.endsWith(BACKGROUND_TERMINAL_SUFFIX)) return;
    frontIds.add(id);
    paneIds.add(id);
  });

  sessionIds.forEach((id) => {
    if (!id.endsWith(BACKGROUND_TERMINAL_SUFFIX)) return;
    const paneId = id.slice(0, -BACKGROUND_TERMINAL_SUFFIX.length);
    if (!paneId) return;
    paneIds.add(paneId);
    backgroundTerminalIds[paneId] = id;
    if (!frontIds.has(paneId)) {
      backgroundTerminalVisible[paneId] = true;
    }
  });

  return {
    paneIds: [...paneIds].sort(comparePaneIds),
    backgroundTerminalIds,
    backgroundTerminalVisible,
  };
}
