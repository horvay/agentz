import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import type { LaunchConfig, PaneLaunchConfig, TerminalFrame } from "../shared/protocol";
import { RpcClient } from "./rpcClient";
import { TerminalPane } from "./TerminalPane";
import type { AvatarDefinition, AvatarId, AvatarVisualState } from "./avatarCatalog";
import { avatarCatalog } from "./avatarCatalog";

const rpc = new RpcClient("ws://127.0.0.1:4599");
const FIRST_ID = "term-1";
const MIN_PANE_WIDTH = 420;
const MAX_PANE_WIDTH = 1400;
const DEFAULT_PANE_WIDTH = 780;
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

function normalizeTerminalText(raw: string): string {
  return raw
    .replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, " ")
    .replace(/[\x00-\x08\x0B-\x1F\x7F]/g, " ")
    .replace(/\s+/g, " ")
    .toLowerCase()
    .trim();
}

function terminalTextWindows(frame?: TerminalFrame): { recent: string; full: string } {
  if (!frame) return { recent: "", full: "" };
  const tailChunk = frame.chunk ? frame.chunk.slice(-2000) : "";
  const tailVt = frame.vt ? frame.vt.slice(-2000) : "";
  const previewLines = frame.previewLines ?? [];
  const screen = previewLines.join("\n");
  return {
    recent: normalizeTerminalText(screen),
    full: normalizeTerminalText(`${screen}\n${tailChunk}\n${tailVt}`),
  };
}

function detectOpencodeAvatarState(frame?: TerminalFrame): AvatarVisualState {
  const windows = terminalTextWindows(frame);
  if (!windows.full) return "idle";
  const { recent, full } = windows;

  const questionMarkers = [
    "permission required",
    "allow once",
    "allow always",
    "reject permission",
    "type your own answer",
    "tell opencode what to do differently",
    "△",
    "select all that apply",
    "esc dismiss",
  ];
  const isQuestion = questionMarkers.some((marker) => recent.includes(marker));

  const callingMarkers = ["delegating...", "↳", "subagent session"];
  const hasLiveCalling = callingMarkers.some((marker) => recent.includes(marker));
  const hasCallingContext =
    recent.includes("view subagents") &&
    recent.includes("toolcalls") &&
    recent.includes("esc interrupt");
  const isCalling = hasLiveCalling || hasCallingContext;

  const workingMarkers = [
    "esc interrupt",
    "esc again to interrupt",
    "_thinking:_",
    "writing command",
    "preparing write",
    "finding files",
    "reading file",
    "searching content",
    "listing directory",
    "fetching from the web",
    "searching code",
    "searching web",
    "preparing edit",
    "preparing patch",
    "updating todos",
    "loading skill",
    "asking questions",
    " queued ",
  ];
  const isWorking = workingMarkers.some((marker) => recent.includes(marker));

  const spinnerChars = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏";
  const hasSpinner = [...spinnerChars].some((ch) => recent.includes(ch));

  const opencodeMarkers = [
    "opencode",
    "opencode zen",
    "ask anything",
    "tab agents",
    "ctrl+p commands",
    "ctrl+t variants",
  ];
  const isOpencode =
    opencodeMarkers.some((marker) => full.includes(marker)) ||
    isQuestion ||
    isCalling ||
    isWorking ||
    hasSpinner;
  if (!isOpencode) return "idle";

  if (isQuestion) return "question";
  if (isCalling) return "calling";
  if (isWorking || hasSpinner) return "working";

  return "idle";
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

function keydownToTerminalInput(event: KeyboardEvent): string | null {
  if (event.isComposing) return null;
  if (event.ctrlKey || event.altKey || event.metaKey) return null;

  switch (event.key) {
    case "Enter":
      return "\r";
    case "Backspace":
      return "\x7f";
    case "Tab":
      return event.shiftKey ? "\x1b[Z" : "\t";
    case "Escape":
      return "\x1b";
    case "ArrowUp":
      return "\x1b[A";
    case "ArrowDown":
      return "\x1b[B";
    case "ArrowRight":
      return "\x1b[C";
    case "ArrowLeft":
      return "\x1b[D";
    case "Home":
      return "\x1b[H";
    case "End":
      return "\x1b[F";
    case "Delete":
      return "\x1b[3~";
    case "PageUp":
      return "\x1b[5~";
    case "PageDown":
      return "\x1b[6~";
    default:
      break;
  }

  if (event.key.length === 1) {
    return event.key;
  }
  return null;
}

function isXtermTextareaFocused(): boolean {
  const active = document.activeElement;
  return active instanceof HTMLElement && Boolean(active.closest(".xterm-helper-textarea"));
}

function App() {
  const [paneIds, setPaneIds] = useState<string[]>([FIRST_ID]);
  const [frames, setFrames] = useState<Record<string, TerminalFrame>>({});
  const [status, setStatus] = useState("Connecting...");
  const [paneStatus, setPaneStatus] = useState<Record<string, "booting" | "running" | "exited" | "error">>({
    [FIRST_ID]: "booting",
  });
  const [activePane, setActivePane] = useState(FIRST_ID);
  const [paneWidths, setPaneWidths] = useState<Record<string, number>>(() => loadStoredPaneWidths());
  const [paneAvatarIds, setPaneAvatarIds] = useState<Record<string, AvatarId>>(() =>
    assignUniqueAvatars([FIRST_ID]),
  );
  const [stripWidth, setStripWidth] = useState(0);
  const [avatarStripWidth, setAvatarStripWidth] = useState(0);
  const [focusRequestSeq, setFocusRequestSeq] = useState(0);
  const activePaneRef = useRef(FIRST_ID);
  const paneIdsRef = useRef<string[]>([FIRST_ID]);
  const nextPaneOrdinalRef = useRef(2);
  const launchConfigRef = useRef<LaunchConfig>({});
  const createdIdsRef = useRef(new Set<string>());
  const paneSlotsRef = useRef<Record<string, HTMLDivElement | null>>({});
  const avatarStripRef = useRef<HTMLDivElement>(null);
  const stripRef = useRef<HTMLDivElement>(null);
  const resizeDragRef = useRef<{ id: string; startX: number; startWidth: number } | null>(null);

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

  const createTerminal = useCallback((id: string, launch?: PaneLaunchConfig) => {
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
    setPaneAvatarIds(assignUniqueAvatars(ids));
    const firstId = ids[0] ?? FIRST_ID;
    setActivePaneCentered(firstId, "auto");
    setFocusRequestSeq((prev) => prev + 1);
    window.setTimeout(() => {
      setActivePaneCentered(firstId, "auto");
      setFocusRequestSeq((prev) => prev + 1);
    }, 120);
    safeLaunchPanes.forEach((launch, index) => {
      createTerminal(ids[index], launch);
    });
  }, [createTerminal, setActivePaneCentered]);

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
    setPaneWidths((prev) => ({ ...prev, [id]: DEFAULT_PANE_WIDTH }));
    setPaneAvatarIds((prev) => {
      const used = new Set(Object.values(prev));
      const avatarId = pickAvailableAvatar(used);
      if (!avatarId) return prev;
      return { ...prev, [id]: avatarId };
    });
    setActivePaneCentered(id);
    createTerminal(id);
  }, [createTerminal, setActivePaneCentered]);

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

  useEffect(() => {
    const disposeReady = rpc.onReady(() => {
      setStatus("Connected");
      rpc.send({ type: "launch-config" });
      // Fallback if server does not reply for any reason.
      window.setTimeout(ensureBootstrapTerminals, 200);
    });
    const disposeLaunchConfig = rpc.onLaunchConfig((config) => {
      launchConfigRef.current = config;
      ensureBootstrapTerminals();
    });
    const disposeCreated = rpc.onCreated((id) => {
      setPaneStatus((prev) => ({ ...prev, [id]: "running" }));
      setStatus("Connected");
    });
    const disposeFrame = rpc.onFrame((frame) => {
      setFrames((prev) => ({ ...prev, [frame.id]: frame }));
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
      setFrames((prev) => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
    });

    rpc.send({ type: "launch-config" });
    window.setTimeout(ensureBootstrapTerminals, 250);

    return () => {
      disposeReady();
      disposeLaunchConfig();
      disposeCreated();
      disposeFrame();
      disposeError();
      disposeExit();
    };
  }, [ensureBootstrapTerminals, setActivePaneCentered]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (isEditableEventTarget(event.target)) return;
      if (event.repeat) return;
      if (!event.ctrlKey || !event.shiftKey) return;
      const key = event.key.toLowerCase();
      if (key === "n") {
        event.preventDefault();
        addTerminalPane();
        return;
      }
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      event.preventDefault();
      moveActivePane(event.key === "ArrowRight" ? "right" : "left");
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [addTerminalPane, moveActivePane]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (isEditableEventTarget(event.target)) return;
      const activeElement = document.activeElement;
      if (activeElement instanceof HTMLElement && activeElement.closest(".xterm-helper-textarea")) return;

      const data = keydownToTerminalInput(event);
      if (!data) return;

      const activeId = activePaneRef.current;
      if (!activeId || !paneIdsRef.current.includes(activeId)) return;

      event.preventDefault();
      rpc.send({ type: "input", id: activeId, data });
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  useEffect(() => {
    const requestFocusRefresh = () => {
      setFocusRequestSeq((prev) => prev + 1);
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        requestFocusRefresh();
      }
    };
    const timeoutA = window.setTimeout(requestFocusRefresh, 0);
    const timeoutB = window.setTimeout(requestFocusRefresh, 260);
    window.addEventListener("focus", requestFocusRefresh);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      window.clearTimeout(timeoutA);
      window.clearTimeout(timeoutB);
      window.removeEventListener("focus", requestFocusRefresh);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, []);

  useEffect(() => {
    let settled = false;
    let sawKeyboardEvent = false;

    const requestDocumentFocus = () => {
      if (settled) return;
      if (!document.hasFocus()) return;
      if (isXtermTextareaFocused()) {
        settled = true;
        return;
      }
      window.focus();
      if (document.documentElement) {
        document.documentElement.tabIndex = -1;
        document.documentElement.focus({ preventScroll: true });
      }
      if (document.body) {
        document.body.tabIndex = -1;
        document.body.focus({ preventScroll: true });
      }
      if (sawKeyboardEvent) {
        settled = true;
      }
    };

    const onKeyDownCapture = () => {
      sawKeyboardEvent = true;
      settled = true;
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        requestDocumentFocus();
      }
    };

    const timers = [0, 70, 160, 320, 640, 1200, 2200].map((delay) =>
      window.setTimeout(requestDocumentFocus, delay),
    );
    const interval = window.setInterval(requestDocumentFocus, 380);
    const stopIntervalTimer = window.setTimeout(() => {
      settled = true;
      window.clearInterval(interval);
    }, 5200);

    window.addEventListener("focus", requestDocumentFocus);
    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("keydown", onKeyDownCapture, true);

    return () => {
      for (const timer of timers) window.clearTimeout(timer);
      window.clearTimeout(stopIntervalTimer);
      window.clearInterval(interval);
      window.removeEventListener("focus", requestDocumentFocus);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("keydown", onKeyDownCapture, true);
    };
  }, []);

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
    const firstWidth = paneWidths[firstId] ?? DEFAULT_PANE_WIDTH;
    return Math.max(0, Math.round(stripWidth / 2 - firstWidth / 2));
  }, [paneIds, paneWidths, stripWidth]);
  const trailSpacerWidth = useMemo(() => {
    if (paneIds.length === 0) return 0;
    const lastId = paneIds[paneIds.length - 1];
    const lastWidth = paneWidths[lastId] ?? DEFAULT_PANE_WIDTH;
    return Math.max(0, Math.round(stripWidth / 2 - lastWidth / 2));
  }, [paneIds, paneWidths, stripWidth]);
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
          {paneIds.length} panes · {frameCount} active frames · Ctrl+Shift+N add · Ctrl+Shift+Left/Right focus
        </span>
      </header>

      <section className="avatar-strip" ref={avatarStripRef} aria-label="Terminal avatars">
        <div className="avatar-track">
          {paneIds.map((id, index) => {
            const avatarId = paneAvatarIds[id];
            const avatar = avatarId ? avatarById[avatarId] : undefined;
            const avatarState = detectOpencodeAvatarState(frames[id]);
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
                {avatar ? (
                  <img src={avatarSrcForState(avatar, avatarState)} alt={avatar.label} className="avatar-image" />
                ) : (
                  <span className="avatar-fallback">{paneTitle(index).slice(-1)}</span>
                )}
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
            style={{ width: `${paneWidths[id] ?? DEFAULT_PANE_WIDTH}px` }}
          >
            <TerminalPane
              id={id}
              rpc={rpc}
              frame={frames[id]}
              active={activePane === id}
              focusRequestSeq={focusRequestSeq}
              onActivate={(nextId) => setActivePaneCentered(nextId)}
              onShortcut={(shortcut) => {
                if (shortcut === "new-pane") {
                  addTerminalPane();
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
                  startWidth: paneWidths[id] ?? DEFAULT_PANE_WIDTH,
                };
                document.body.classList.add("pane-resize-active");
              }}
            />
          </div>
        ))}
        <div className="pane-edge-spacer" style={{ width: `${trailSpacerWidth}px` }} aria-hidden />
      </section>
    </main>
  );
}

export default App;
