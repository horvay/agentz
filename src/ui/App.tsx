import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import type { LaunchConfig, PaneLaunchConfig, TerminalFrame } from "../shared/protocol";
import {
  cloneDashboardConfig,
  DEFAULT_DASHBOARD_CONFIG,
  MAX_PANE_WIDTH,
  MIN_PANE_WIDTH,
  type DashboardConfig,
} from "../shared/config";
import { RpcClient } from "./rpcClient";
import { SettingsModal } from "./SettingsModal";
import { TerminalPane } from "./TerminalPane";
import type { AvatarDefinition, AvatarId, AvatarVisualState } from "./avatarCatalog";
import { avatarCatalog } from "./avatarCatalog";
import { inspectAvatarState, resolveAvatarDisplayState, type AgentKind } from "./avatarState";
import { doesEventMatchShortcut } from "./shortcuts";
import idleIconUrl from "../../assets/icons/idle.svg";
import questionIconUrl from "../../assets/icons/question.svg";

const rpc = new RpcClient("ws://127.0.0.1:4599");
const FIRST_ID = "term-1";
const WIDTH_STORAGE_KEY = "ghostty.dashboard.paneWidths.v1";
const MAX_AVATAR_PANES = avatarCatalog.length;
const AVATAR_IDS = avatarCatalog.map((avatar) => avatar.id);
const avatarById: Record<AvatarId, AvatarDefinition> = Object.fromEntries(
  avatarCatalog.map((avatar) => [avatar.id, avatar]),
) as Record<AvatarId, AvatarDefinition>;

function paneTitle(index: number): string {
  if (index < 26) return `Pane ${String.fromCharCode(65 + index)}`;
  return `Pane ${index + 1}`;
}

function normalizeLaunchPanes(config: LaunchConfig): PaneLaunchConfig[] {
  if (Array.isArray(config.panes) && config.panes.length > 0) {
    return config.panes;
  }
  const legacy = [config.paneA, config.paneB].filter(
    (pane): pane is PaneLaunchConfig => Boolean(pane),
  );
  if (legacy.length > 0) return legacy;
  return [{}];
}

function loadStoredPaneWidths(): Record<string, number> {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(WIDTH_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const out: Record<string, number> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value !== "number" || !Number.isFinite(value)) continue;
      out[key] = Math.max(MIN_PANE_WIDTH, Math.min(MAX_PANE_WIDTH, Math.round(value)));
    }
    return out;
  } catch {
    return {};
  }
}

function shuffleAvatarIds(ids: AvatarId[]): AvatarId[] {
  const next = [...ids];
  for (let i = next.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [next[i], next[j]] = [next[j], next[i]];
  }
  return next;
}

function assignUniqueAvatars(ids: string[]): Record<string, AvatarId> {
  const shuffled = shuffleAvatarIds(AVATAR_IDS);
  const out: Record<string, AvatarId> = {};
  ids.slice(0, shuffled.length).forEach((id, index) => {
    out[id] = shuffled[index];
  });
  return out;
}

function pickAvailableAvatar(used: Set<AvatarId>): AvatarId | null {
  const available = AVATAR_IDS.filter((id) => !used.has(id));
  if (available.length === 0) return null;
  return available[Math.floor(Math.random() * available.length)];
}

function avatarSrcForState(avatar: AvatarDefinition, state: AvatarVisualState): string {
  if (state === "working") return avatar.workingSrc;
  if (state === "question") return avatar.questionSrc;
  if (state === "calling") return avatar.callingSrc;
  return avatar.idleSrc;
}

function isEditableEventTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.tagName === "INPUT" ||
    target.tagName === "TEXTAREA" ||
    target.isContentEditable ||
    Boolean(target.closest(".xterm-helper-textarea"))
  );
}

function App() {
  const [paneIds, setPaneIds] = useState<string[]>([FIRST_ID]);
  const [frames, setFrames] = useState<Record<string, TerminalFrame>>({});
  const [frameQueues, setFrameQueues] = useState<Record<string, TerminalFrame[]>>({});
  const [status, setStatus] = useState("Connecting...");
  const [paneStatus, setPaneStatus] = useState<Record<string, "booting" | "running" | "exited" | "error">>({
    [FIRST_ID]: "booting",
  });
  const [dashboardConfig, setDashboardConfig] = useState<DashboardConfig>(() =>
    cloneDashboardConfig(DEFAULT_DASHBOARD_CONFIG),
  );
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [activePane, setActivePane] = useState(FIRST_ID);
  const [paneWidths, setPaneWidths] = useState<Record<string, number>>(() => loadStoredPaneWidths());
  const [paneAvatarIds, setPaneAvatarIds] = useState<Record<string, AvatarId>>(() =>
    assignUniqueAvatars([FIRST_ID]),
  );
  const [avatarStates, setAvatarStates] = useState<Record<string, AvatarVisualState>>({
    [FIRST_ID]: "idle",
  });
  const [stripWidth, setStripWidth] = useState(0);
  const [avatarStripWidth, setAvatarStripWidth] = useState(0);
  const activePaneRef = useRef(FIRST_ID);
  const paneIdsRef = useRef<string[]>([FIRST_ID]);
  const nextPaneOrdinalRef = useRef(2);
  const launchConfigRef = useRef<LaunchConfig>({});
  const createdIdsRef = useRef(new Set<string>());
  const paneSlotsRef = useRef<Record<string, HTMLDivElement | null>>({});
  const avatarStripRef = useRef<HTMLDivElement>(null);
  const stripRef = useRef<HTMLDivElement>(null);
  const resizeDragRef = useRef<{ id: string; startX: number; startWidth: number } | null>(null);
  const avatarActivityRef = useRef<
    Record<
      string,
      {
        state: AvatarVisualState;
        agent: AgentKind;
        atMs: number;
        lastFrameAtMs: number;
        lastPreviewText: string;
      }
    >
  >({});
  const bootstrappedRef = useRef(false);
  const hasLaunchConfigRef = useRef(false);
  const hasDashboardConfigRef = useRef(false);
  const bootstrapFallbackTimerRef = useRef<number | null>(null);
  const shortcuts = dashboardConfig.shortcuts;
  const defaultPaneWidth = dashboardConfig.defaultPaneWidth;
  const defaultPaneWidthRef = useRef(defaultPaneWidth);

  const centerNode = useCallback((container: HTMLElement | null, node: HTMLElement | null, behavior: ScrollBehavior) => {
    if (!container || !node) return;
    const idealLeft = node.offsetLeft - (container.clientWidth - node.clientWidth) / 2;
    const maxScroll = Math.max(0, container.scrollWidth - container.clientWidth);
    const nextLeft = Math.max(0, Math.min(maxScroll, idealLeft));
    container.scrollTo({ left: nextLeft, behavior });
  }, []);

  const centerPane = useCallback(
    (id: string, behavior: ScrollBehavior = "smooth") => {
      centerNode(stripRef.current, paneSlotsRef.current[id], behavior);
    },
    [centerNode],
  );

  const setActivePaneCentered = useCallback(
    (id: string, behavior: ScrollBehavior = "smooth") => {
      setActivePane(id);
      requestAnimationFrame(() => {
        centerPane(id, behavior);
      });
    },
    [centerPane],
  );

  useEffect(() => {
    activePaneRef.current = activePane;
  }, [activePane]);

  useEffect(() => {
    const strip = stripRef.current;
    if (!strip) return;
    const syncWidth = () => setStripWidth(strip.clientWidth);
    syncWidth();
    const observer = new ResizeObserver(syncWidth);
    observer.observe(strip);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const avatarStrip = avatarStripRef.current;
    if (!avatarStrip) return;
    const syncWidth = () => setAvatarStripWidth(avatarStrip.clientWidth);
    syncWidth();
    const observer = new ResizeObserver(syncWidth);
    observer.observe(avatarStrip);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    paneIdsRef.current = paneIds;
  }, [paneIds]);

  useEffect(() => {
    defaultPaneWidthRef.current = defaultPaneWidth;
  }, [defaultPaneWidth]);

  const createTerminal = useCallback((
    id: string,
    launch?: PaneLaunchConfig,
    options?: { inheritCwdFromId?: string },
  ) => {
    if (createdIdsRef.current.has(id)) return;
    createdIdsRef.current.add(id);
    rpc.send({
      type: "create",
      id,
      cols: 120,
      rows: 36,
      command: launch?.command,
      args: launch?.args,
      cwd: launch?.cwd,
      inheritCwdFromId: launch?.cwd ? undefined : options?.inheritCwdFromId,
    });
  }, []);

  const ensureBootstrapTerminals = useCallback(() => {
    const launchPanes = normalizeLaunchPanes(launchConfigRef.current);
    const cappedLaunchPanes = launchPanes.slice(0, MAX_AVATAR_PANES);
    if (launchPanes.length > MAX_AVATAR_PANES) {
      setStatus(`Launch config capped at ${MAX_AVATAR_PANES} panes`);
    }
    const safeLaunchPanes = cappedLaunchPanes.length > 0 ? cappedLaunchPanes : [{}];
    const ids = safeLaunchPanes.map((_, index) => `term-${index + 1}`);
    const statusInit: Record<string, "booting" | "running" | "exited" | "error"> = {};
    for (const id of ids) statusInit[id] = "booting";
    nextPaneOrdinalRef.current = ids.length + 1;
    setPaneIds(ids);
    setPaneStatus(statusInit);
    setPaneWidths((prev) => {
      const next: Record<string, number> = {};
      for (const id of ids) {
        next[id] = prev[id] ?? defaultPaneWidthRef.current;
      }
      return next;
    });
    setPaneAvatarIds(assignUniqueAvatars(ids));
    setAvatarStates(Object.fromEntries(ids.map((id) => [id, "idle" as const])));
    avatarActivityRef.current = {};
    const firstId = ids[0] ?? FIRST_ID;
    setActivePaneCentered(firstId, "auto");
    safeLaunchPanes.forEach((launch, index) => {
      createTerminal(ids[index], launch);
    });
  }, [createTerminal, setActivePaneCentered]);

  const maybeBootstrapTerminals = useCallback(
    (force = false) => {
      if (bootstrappedRef.current) return;
      if (!force && (!hasLaunchConfigRef.current || !hasDashboardConfigRef.current)) return;
      bootstrappedRef.current = true;
      if (bootstrapFallbackTimerRef.current) {
        window.clearTimeout(bootstrapFallbackTimerRef.current);
        bootstrapFallbackTimerRef.current = null;
      }
      ensureBootstrapTerminals();
    },
    [ensureBootstrapTerminals],
  );

  const armBootstrapFallback = useCallback(() => {
    if (bootstrapFallbackTimerRef.current) {
      window.clearTimeout(bootstrapFallbackTimerRef.current);
    }
    bootstrapFallbackTimerRef.current = window.setTimeout(() => {
      bootstrapFallbackTimerRef.current = null;
      maybeBootstrapTerminals(true);
    }, 1200);
  }, [maybeBootstrapTerminals]);

  const addTerminalPane = useCallback(() => {
    if (paneIdsRef.current.length >= MAX_AVATAR_PANES) {
      setStatus(`Maximum ${MAX_AVATAR_PANES} panes reached`);
      return;
    }
    const existing = new Set(paneIdsRef.current);
    let nextOrdinal = nextPaneOrdinalRef.current;
    while (existing.has(`term-${nextOrdinal}`)) {
      nextOrdinal += 1;
    }
    const id = `term-${nextOrdinal}`;
    nextPaneOrdinalRef.current = nextOrdinal + 1;
    setPaneIds((prev) => [...prev, id]);
    setPaneStatus((prev) => ({ ...prev, [id]: "booting" }));
    setPaneWidths((prev) => ({ ...prev, [id]: defaultPaneWidth }));
    setPaneAvatarIds((prev) => {
      const used = new Set(Object.values(prev));
      const avatarId = pickAvailableAvatar(used);
      if (!avatarId) return prev;
      return { ...prev, [id]: avatarId };
    });
    setAvatarStates((prev) => ({ ...prev, [id]: "idle" }));
    setActivePaneCentered(id);
    createTerminal(id, undefined, { inheritCwdFromId: activePaneRef.current });
  }, [createTerminal, defaultPaneWidth, setActivePaneCentered]);

  const moveActivePane = useCallback(
    (direction: "left" | "right") => {
      if (paneIdsRef.current.length < 2) return;
      const currentIndex = paneIdsRef.current.indexOf(activePaneRef.current);
      if (currentIndex < 0) return;
      const step = direction === "right" ? 1 : -1;
      const nextIndex = Math.max(0, Math.min(paneIdsRef.current.length - 1, currentIndex + step));
      if (nextIndex === currentIndex) return;
      setActivePaneCentered(paneIdsRef.current[nextIndex]);
    },
    [setActivePaneCentered],
  );

  const openSettings = useCallback(() => {
    setSettingsOpen(true);
  }, []);

  const saveDashboardConfig = useCallback((nextConfig: DashboardConfig) => {
    setDashboardConfig(nextConfig);
    rpc.send({ type: "set-config", config: nextConfig });
    setStatus("Settings saved");
  }, []);

  useEffect(() => {
    const disposeReady = rpc.onReady(() => {
      setStatus("Connected");
      rpc.send({ type: "launch-config" });
      rpc.send({ type: "get-config" });
      armBootstrapFallback();
    });
    const disposeConfig = rpc.onConfig((config) => {
      defaultPaneWidthRef.current = config.defaultPaneWidth;
      hasDashboardConfigRef.current = true;
      setDashboardConfig(config);
      maybeBootstrapTerminals();
    });
    const disposeLaunchConfig = rpc.onLaunchConfig((config) => {
      launchConfigRef.current = config;
      hasLaunchConfigRef.current = true;
      maybeBootstrapTerminals();
    });
    const disposeCreated = rpc.onCreated((id) => {
      setPaneStatus((prev) => ({ ...prev, [id]: "running" }));
      setStatus("Connected");
    });
    const disposeFrame = rpc.onFrame((frame) => {
      const nowMs = Date.now();
      const previousActivity = avatarActivityRef.current[frame.id];
      const displayState = resolveAvatarDisplayState(frame, previousActivity, nowMs);
      // Preserve the last known agent kind even after identifying text scrolls off screen.
      const nextAgent = inspectAvatarState(frame).agent ?? previousActivity?.agent ?? null;
      const nextPreviewText = (frame.previewLines ?? []).join("\n");
      avatarActivityRef.current[frame.id] =
        displayState !== "idle"
          ? {
              state: displayState,
              agent: nextAgent,
              atMs: nowMs,
              lastFrameAtMs: nowMs,
              lastPreviewText: nextPreviewText,
            }
          : previousActivity
            ? {
                ...previousActivity,
                agent: nextAgent,
                lastFrameAtMs: nowMs,
                lastPreviewText: nextPreviewText,
              }
            : {
                state: "idle",
                agent: nextAgent,
                atMs: nowMs,
                lastFrameAtMs: nowMs,
                lastPreviewText: nextPreviewText,
              };
      setFrames((prev) => ({ ...prev, [frame.id]: frame }));
      setAvatarStates((prev) => ({ ...prev, [frame.id]: displayState }));
      setFrameQueues((prev) => ({
        ...prev,
        [frame.id]: [...(prev[frame.id] ?? []), frame],
      }));
      setPaneStatus((prev) => ({ ...prev, [frame.id]: "running" }));
      setStatus("Connected");
    });
    const disposeError = rpc.onError((message) => {
      setStatus(`RPC error: ${message}`);
      setPaneStatus((prev) => ({ ...prev, [activePaneRef.current]: "error" }));
    });
    const disposeExit = rpc.onExit((id, code) => {
      setStatus(`${id} exited (${code})`);
      setPaneIds((prev) => {
        const closedIndex = prev.indexOf(id);
        if (closedIndex < 0) return prev;
        const next = prev.filter((paneId) => paneId !== id);
        if (activePaneRef.current === id) {
          const fallback = next[closedIndex] ?? next[closedIndex - 1] ?? next[0] ?? "";
          if (fallback) setActivePaneCentered(fallback);
        }
        return next;
      });
      setPaneStatus((prev) => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
      setPaneAvatarIds((prev) => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
      setAvatarStates((prev) => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
      delete avatarActivityRef.current[id];
      setPaneWidths((prev) => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
      setFrames((prev) => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
      setFrameQueues((prev) => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
    });

    rpc.send({ type: "launch-config" });
    rpc.send({ type: "get-config" });
    armBootstrapFallback();

    return () => {
      if (bootstrapFallbackTimerRef.current) {
        window.clearTimeout(bootstrapFallbackTimerRef.current);
        bootstrapFallbackTimerRef.current = null;
      }
      disposeReady();
      disposeConfig();
      disposeLaunchConfig();
      disposeCreated();
      disposeFrame();
      disposeError();
      disposeExit();
    };
  }, [armBootstrapFallback, maybeBootstrapTerminals, setActivePaneCentered]);

  const handleFramesQueued = useCallback((id: string, lastSeq: number) => {
    setFrameQueues((prev) => {
      const pending = prev[id];
      if (!pending?.length) return prev;
      const nextPending = pending.filter((frame) => frame.seq > lastSeq);
      if (nextPending.length === pending.length) return prev;
      if (nextPending.length === 0) {
        const next = { ...prev };
        delete next[id];
        return next;
      }
      return { ...prev, [id]: nextPending };
    });
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat) return;
      if (settingsOpen) return;
      if (isEditableEventTarget(event.target)) return;

      if (doesEventMatchShortcut(event, shortcuts.openSettings)) {
        event.preventDefault();
        openSettings();
        return;
      }
      if (doesEventMatchShortcut(event, shortcuts.addPane)) {
        event.preventDefault();
        addTerminalPane();
        return;
      }
      if (doesEventMatchShortcut(event, shortcuts.focusPrevPane)) {
        event.preventDefault();
        moveActivePane("left");
        return;
      }
      if (doesEventMatchShortcut(event, shortcuts.focusNextPane)) {
        event.preventDefault();
        moveActivePane("right");
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [addTerminalPane, moveActivePane, openSettings, settingsOpen, shortcuts]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      const nowMs = Date.now();
      setAvatarStates((prev) => {
        let changed = false;
        const next = { ...prev };
        for (const [id, currentState] of Object.entries(prev)) {
          if (currentState !== "working") continue;
          const activity = avatarActivityRef.current[id];
          const frame = frames[id];
          const nextState = resolveAvatarDisplayState(frame, activity, nowMs);
          if (nextState === currentState) continue;
          next[id] = nextState;
          changed = true;
          if (activity) {
            avatarActivityRef.current[id] = {
              ...activity,
              state: nextState,
            };
          }
        }
        return changed ? next : prev;
      });
    }, 400);
    return () => window.clearInterval(timer);
  }, [frames]);

  useEffect(() => {
    centerPane(activePane, "smooth");
  }, [activePane, centerPane]);

  useEffect(() => {
    const firstId = paneIds[0];
    if (!firstId) return;
    requestAnimationFrame(() => {
      centerPane(activePaneRef.current || firstId, "auto");
    });
  }, [paneIds, stripWidth, centerPane]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(WIDTH_STORAGE_KEY, JSON.stringify(paneWidths));
  }, [paneWidths]);

  useEffect(() => {
    const onMove = (event: MouseEvent) => {
      const drag = resizeDragRef.current;
      if (!drag) return;
      const next = drag.startWidth + (event.clientX - drag.startX);
      const clamped = Math.max(MIN_PANE_WIDTH, Math.min(MAX_PANE_WIDTH, Math.round(next)));
      setPaneWidths((prev) => ({ ...prev, [drag.id]: clamped }));
    };
    const onUp = () => {
      if (!resizeDragRef.current) return;
      resizeDragRef.current = null;
      document.body.classList.remove("pane-resize-active");
      centerPane(activePaneRef.current, "auto");
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      document.body.classList.remove("pane-resize-active");
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [centerPane]);

  const frameCount = useMemo(() => Object.keys(frames).length, [frames]);
  const connectedLabel = frameCount > 0 ? "Connected" : status;
  const leadSpacerWidth = useMemo(() => {
    if (paneIds.length === 0) return 0;
    const firstId = paneIds[0];
    const firstWidth = paneWidths[firstId] ?? defaultPaneWidth;
    return Math.max(0, Math.round(stripWidth / 2 - firstWidth / 2));
  }, [defaultPaneWidth, paneIds, paneWidths, stripWidth]);
  const trailSpacerWidth = useMemo(() => {
    if (paneIds.length === 0) return 0;
    const lastId = paneIds[paneIds.length - 1];
    const lastWidth = paneWidths[lastId] ?? defaultPaneWidth;
    return Math.max(0, Math.round(stripWidth / 2 - lastWidth / 2));
  }, [defaultPaneWidth, paneIds, paneWidths, stripWidth]);
  const activeAvatarIndex = useMemo(() => {
    const index = paneIds.indexOf(activePane);
    return index >= 0 ? index : 0;
  }, [activePane, paneIds]);
  const avatarLayout = useMemo(() => {
    const chipWidth = 132;
    const edgePadding = 12;
    const maxDistance = Math.max(activeAvatarIndex, paneIds.length - 1 - activeAvatarIndex);
    const usableHalf = Math.max(0, avatarStripWidth / 2 - chipWidth / 2 - edgePadding);
    const centerGap = Math.min(96, usableHalf);
    const laneStep =
      maxDistance > 1 ? Math.max(12, (usableHalf - centerGap) / (maxDistance - 1)) : 0;
    return { centerGap, laneStep };
  }, [activeAvatarIndex, avatarStripWidth, paneIds.length]);

  return (
    <main className="app-shell">
      <header className="topbar topbar-compact">
        <span className="status-chip">{connectedLabel}</span>
        <span className="status-metric">
          {paneIds.length} panes · {frameCount} active frames · {shortcuts.addPane} add ·{" "}
          {shortcuts.focusPrevPane}/{shortcuts.focusNextPane} focus
        </span>
        <span className="topbar-spacer" />
        <button type="button" className="topbar-settings-button" onClick={openSettings}>
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M19.14 12.94c.04-.3.06-.62.06-.94s-.02-.64-.07-.94l2.03-1.58a.5.5 0 0 0 .12-.63l-1.92-3.32a.5.5 0 0 0-.6-.22l-2.39.96a7.16 7.16 0 0 0-1.62-.94l-.36-2.54a.5.5 0 0 0-.5-.42h-3.84a.5.5 0 0 0-.5.42l-.36 2.54c-.57.23-1.11.54-1.62.94l-2.39-.96a.5.5 0 0 0-.6.22L2.7 8.85a.5.5 0 0 0 .12.63l2.03 1.58c-.05.3-.07.62-.07.94s.02.64.07.94L2.82 14.52a.5.5 0 0 0-.12.63l1.92 3.32c.13.23.4.32.64.22l2.35-.95c.5.4 1.05.73 1.65.97l.36 2.5a.5.5 0 0 0 .5.42h3.84a.5.5 0 0 0 .5-.42l.36-2.5c.6-.24 1.15-.57 1.65-.97l2.35.95c.24.1.51.01.64-.22l1.92-3.32a.5.5 0 0 0-.12-.63l-2.03-1.58zM12 15.5A3.5 3.5 0 1 1 12 8.5a3.5 3.5 0 0 1 0 7z" />
          </svg>
          <span>Settings</span>
          <kbd>{shortcuts.openSettings}</kbd>
        </button>
      </header>

      <section className="avatar-strip" ref={avatarStripRef} aria-label="Terminal avatars">
        <div className="avatar-track">
          {paneIds.map((id, index) => {
            const avatarId = paneAvatarIds[id];
            const avatar = avatarId ? avatarById[avatarId] : undefined;
            const avatarState = avatarStates[id] ?? "idle";
            const isActive = activePane === id;
            const relative = index - activeAvatarIndex;
            const direction = relative === 0 ? 0 : relative > 0 ? 1 : -1;
            const distance = Math.abs(relative);
            const spread =
              distance === 0
                ? 0
                : avatarLayout.centerGap + (distance - 1) * avatarLayout.laneStep;
            const offset = direction * spread;
            const scale = isActive ? 1 : Math.max(0.72, 0.9 - distance * 0.11);
            const avatarStyle = {
              "--offset": `${offset}px`,
              "--scale": scale,
              "--opacity": 1,
              zIndex: `${120 - distance}`,
            } as CSSProperties;

            return (
              <button
                key={`avatar-${id}`}
                type="button"
                className={`avatar-chip ${isActive ? "avatar-chip-active" : ""}`}
                style={avatarStyle}
                onClick={() => setActivePaneCentered(id)}
                aria-label={`Focus ${paneTitle(index)}`}
                title={`${avatar?.label ?? "Unassigned"} - ${paneTitle(index)}`}
              >
                <span className="avatar-image-wrap">
                  {avatar ? (
                    <img src={avatarSrcForState(avatar, avatarState)} alt={avatar.label} className="avatar-image" />
                  ) : (
                    <span className="avatar-fallback">{paneTitle(index).slice(-1)}</span>
                  )}
                  {avatarState === "idle" && (
                    <img src={idleIconUrl} alt="" className="avatar-state-badge avatar-badge-idle" />
                  )}
                  {avatarState === "question" && (
                    <img src={questionIconUrl} alt="" className="avatar-state-badge avatar-badge-question" />
                  )}
                </span>
                <span className="avatar-name">{avatar?.label ?? "Unassigned"}</span>
              </button>
            );
          })}
        </div>
      </section>

      <section className="pane-grid" ref={stripRef}>
        <div className="pane-edge-spacer" style={{ width: `${leadSpacerWidth}px` }} aria-hidden />
        {paneIds.map((id, index) => (
          <div
            key={id}
            className="pane-slot"
            ref={(node) => {
              paneSlotsRef.current[id] = node;
            }}
            style={{ width: `${paneWidths[id] ?? defaultPaneWidth}px` }}
          >
            <TerminalPane
              id={id}
              rpc={rpc}
              pendingFrames={frameQueues[id]}
              active={activePane === id}
              shortcuts={shortcuts}
              onActivate={(nextId) => setActivePaneCentered(nextId)}
              onFramesQueued={handleFramesQueued}
              onShortcut={(shortcut) => {
                if (shortcut === "new-pane") {
                  addTerminalPane();
                  return;
                }
                if (shortcut === "open-settings") {
                  openSettings();
                  return;
                }
                moveActivePane(shortcut === "focus-right" ? "right" : "left");
              }}
            />
            <div
              className="pane-resize-handle"
              role="separator"
              aria-orientation="vertical"
              aria-label={`Resize ${paneTitle(index)}`}
              onMouseDown={(event) => {
                event.preventDefault();
                resizeDragRef.current = {
                  id,
                  startX: event.clientX,
                  startWidth: paneWidths[id] ?? defaultPaneWidth,
                };
                document.body.classList.add("pane-resize-active");
              }}
            />
          </div>
        ))}
        <div className="pane-edge-spacer" style={{ width: `${trailSpacerWidth}px` }} aria-hidden />
      </section>
      <SettingsModal
        open={settingsOpen}
        config={dashboardConfig}
        onClose={() => setSettingsOpen(false)}
        onSave={saveDashboardConfig}
      />
    </main>
  );
}

export default App;
