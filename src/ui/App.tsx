import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
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
import { previewTextForPane } from "./panePreview";
import {
  paneRuntimeStore,
  type PaneRuntimeState,
  type PaneRuntimeStatus,
  usePaneFrameCount,
  usePaneRuntime,
} from "./paneRuntimeStore";
import {
  FOLDER_ACCENT_PALETTE,
  folderAccentKey,
  resolveFolderAccentAssignments,
} from "./folderAccent";
import { coalesceQueuedRenderFrames } from "./renderQueues";
import { doesEventMatchShortcut } from "./shortcuts";
import { selectLivePaneIds } from "./livePaneSelection";
import idleIconUrl from "../../assets/icons/idle.svg";
import questionIconUrl from "../../assets/icons/question.svg";

function resolveRpcUrl(): string {
  if (typeof window === "undefined") {
    return "ws://127.0.0.1:4599";
  }

  const { hostname, protocol } = window.location;
  if (!hostname) {
    return "ws://127.0.0.1:4599";
  }

  const wsProtocol = protocol === "https:" ? "wss:" : "ws:";
  return `${wsProtocol}//${hostname}:4599`;
}

const rpc = new RpcClient(resolveRpcUrl());
const FIRST_ID = "term-1";
const WIDTH_STORAGE_KEY = "ghostty.dashboard.paneWidths.v1";
const MAX_AVATAR_PANES = avatarCatalog.length;
const MAX_ACTIVITY_CHUNK_CHARS = 4_000;
const MAX_ACTIVITY_VT_CHARS = 4_000;
const ACTIVE_INPUT_FLOW_HOLD_MS = 180;
const LIVE_VISIBLE_PANE_FRAME_INTERVAL_MS = 90;
const VISIBLE_PANE_INTERSECTION_RATIO = 0.2;
const AVATAR_IDS = avatarCatalog.map((avatar) => avatar.id);
const avatarById: Record<AvatarId, AvatarDefinition> = Object.fromEntries(
  avatarCatalog.map((avatar) => [avatar.id, avatar]),
) as Record<AvatarId, AvatarDefinition>;

function paneTitle(index: number): string {
  if (index < 26) return `Pane ${String.fromCharCode(65 + index)}`;
  return `Pane ${index + 1}`;
}

function normalizeLaunchPanes(config: LaunchConfig): PaneLaunchConfig[] {
  return Array.isArray(config.panes) ? config.panes : [];
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

function folderLabel(cwd?: string): string {
  if (!cwd) return "Starting...";
  const normalized = cwd.replace(/\/+$/, "") || "/";
  const segments = normalized.split("/").filter(Boolean);
  return segments[segments.length - 1] ?? "/";
}

function accentVars(accent: (typeof FOLDER_ACCENT_PALETTE)[number]): CSSProperties {
  const { hue, saturation, lightness } = accent;
  return {
    "--folder-accent": `hsl(${hue} ${saturation}% ${lightness}%)`,
    "--folder-accent-soft": `hsl(${hue} ${Math.max(44, saturation - 22)}% ${Math.max(18, lightness - 40)}% / 0.4)`,
    "--folder-accent-border": `hsl(${hue} ${Math.max(62, saturation - 6)}% ${Math.max(44, lightness - 14)}% / 0.82)`,
    "--folder-accent-glow": `hsl(${hue} ${Math.max(70, saturation - 4)}% ${lightness}% / 0.42)`,
  } as CSSProperties;
}

const ACCENT_STYLE_BY_SLOT = FOLDER_ACCENT_PALETTE.map((accent) => accentVars(accent));

function isEditableEventTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.tagName === "INPUT" ||
    target.tagName === "TEXTAREA" ||
    target.isContentEditable ||
    Boolean(target.closest(".xterm-helper-textarea")) ||
    Boolean(target.closest(".terminal-input-capture"))
  );
}

function isTerminalPasteTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && Boolean(target.closest(".xterm-helper-textarea"));
}

function firstImageClipboardFile(clipboardData: DataTransfer | null | undefined): File | null {
  if (!clipboardData) return null;
  const items = Array.from(clipboardData.items ?? []);
  for (const item of items) {
    if (item.kind !== "file" || !item.type.startsWith("image/")) continue;
    const file = item.getAsFile();
    if (file) return file;
  }
  return null;
}

function readFileAsBase64(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("Failed to read pasted image"));
    reader.onload = () => {
      if (typeof reader.result !== "string") {
        reject(new Error("Failed to decode pasted image"));
        return;
      }
      const [, base64 = ""] = reader.result.split(",", 2);
      resolve(base64);
    };
    reader.readAsDataURL(file);
  });
}

function compactFrameForActivity(frame: TerminalFrame): TerminalFrame {
  return {
    id: frame.id,
    cols: frame.cols,
    rows: frame.rows,
    seq: frame.seq,
    cwd: frame.cwd,
    renderPatchKind: frame.renderPatchKind,
    renderPatchVt: frame.renderPatchVt,
    chunk: frame.chunk.slice(-MAX_ACTIVITY_CHUNK_CHARS),
    vt: frame.vt.slice(-MAX_ACTIVITY_VT_CHARS),
    previewLines: frame.previewLines,
    shellBusy: frame.shellBusy,
    shellBusyAtMs: frame.shellBusyAtMs,
    altScreen: frame.altScreen,
    cursorVisible: frame.cursorVisible,
    cursorStyle: frame.cursorStyle,
    cursorBlink: frame.cursorBlink,
    cursorRow: frame.cursorRow,
    cursorCol: frame.cursorCol,
    mouseTrackingMode: frame.mouseTrackingMode,
    mouseFormat: frame.mouseFormat,
    focusEvent: frame.focusEvent,
    mouseAlternateScroll: frame.mouseAlternateScroll,
  };
}

function nextAvatarActivity(
  frame: TerminalFrame,
  previous:
    | {
        state: AvatarVisualState;
        agent: AgentKind;
        atMs: number;
        lastFrameAtMs: number;
        lastPreviewText: string;
      }
    | undefined,
  nowMs: number,
): {
  displayState: AvatarVisualState;
  activity: {
    state: AvatarVisualState;
    agent: AgentKind;
    atMs: number;
    lastFrameAtMs: number;
    lastPreviewText: string;
  };
} {
  const displayState = resolveAvatarDisplayState(frame, previous, nowMs);
  const nextAgent = inspectAvatarState(frame).agent ?? previous?.agent ?? null;
  const nextPreviewText = (frame.previewLines ?? []).join("\n");
  return {
    displayState,
    activity:
      displayState !== "idle"
        ? {
            state: displayState,
            agent: nextAgent,
            atMs: nowMs,
            lastFrameAtMs: nowMs,
            lastPreviewText: nextPreviewText,
          }
        : previous
          ? {
              ...previous,
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
            },
  };
}

function compactFrameForRender(frame: TerminalFrame): TerminalFrame {
  return {
    id: frame.id,
    cols: frame.cols,
    rows: frame.rows,
    seq: frame.seq,
    cwd: frame.cwd,
    screenMode: frame.screenMode,
    screenRows: frame.screenRows,
    renderVt: frame.renderVt,
    renderPatchVt: frame.renderPatchVt,
    renderPatchBytes: frame.renderPatchBytes,
    renderPatchKind: frame.renderPatchKind,
    altScreen: frame.altScreen,
    chunk: frame.chunk,
    vt: "",
    previewLines: [],
    cursorVisible: frame.cursorVisible,
    cursorStyle: frame.cursorStyle,
    cursorBlink: frame.cursorBlink,
    cursorRow: frame.cursorRow,
    cursorCol: frame.cursorCol,
    mouseTrackingMode: frame.mouseTrackingMode,
    mouseFormat: frame.mouseFormat,
    focusEvent: frame.focusEvent,
    mouseAlternateScroll: frame.mouseAlternateScroll,
    shellBusy: frame.shellBusy,
  };
}

interface PendingPaneFrameUpdate {
  activityFrame: TerminalFrame;
  renderFrames: TerminalFrame[];
}

function mergePreviewLines(existing: string[], next: string[] | undefined): string[] {
  return next && next.length > 0 ? next : existing;
}

function mergeActivityFrame(existing: TerminalFrame | undefined, next: TerminalFrame): TerminalFrame {
  if (!existing) return next;
  const isCursorOnly = next.renderPatchKind === "cursor-only";
  const isMetadataOnly =
    !next.renderVt && !next.renderPatchVt && !next.renderPatchBytes && !next.screenRows?.length && !next.chunk;
  if (!isCursorOnly && !isMetadataOnly) return next;
  return {
    ...existing,
    seq: next.seq,
    cols: next.cols,
    rows: next.rows,
    cwd: next.cwd ?? existing.cwd,
    vt: next.vt || existing.vt,
    previewLines: mergePreviewLines(existing.previewLines, next.previewLines),
    renderPatchKind: next.renderPatchKind,
    renderPatchVt: next.renderPatchVt,
    renderPatchBytes: next.renderPatchBytes,
    altScreen: next.altScreen ?? existing.altScreen,
    cursorVisible: next.cursorVisible,
    cursorStyle: next.cursorStyle,
    cursorBlink: next.cursorBlink,
    cursorRow: next.cursorRow,
    cursorCol: next.cursorCol,
    mouseTrackingMode: next.mouseTrackingMode,
    mouseFormat: next.mouseFormat,
    focusEvent: next.focusEvent,
    mouseAlternateScroll: next.mouseAlternateScroll,
    shellBusy: next.shellBusy ?? existing.shellBusy,
    shellBusyAtMs: next.shellBusyAtMs ?? existing.shellBusyAtMs,
  };
}

function backgroundFrameIntervalForPaneCount(paneCount: number): number {
  if (paneCount <= 1) return 0;
  if (paneCount >= 8) return 480;
  if (paneCount >= 5) return 320;
  if (paneCount >= 3) return 220;
  return 150;
}

interface AvatarChipProps {
  id: string;
  index: number;
  avatar?: AvatarDefinition;
  avatarState: AvatarVisualState;
  cwd?: string;
  isActive: boolean;
  offset: number;
  scale: number;
  zIndex: number;
  accentStyle?: CSSProperties;
  onActivate: (id: string) => void;
}

const AvatarChip = memo(function AvatarChip({
  id,
  index,
  avatar,
  avatarState,
  cwd,
  isActive,
  offset,
  scale,
  zIndex,
  accentStyle,
  onActivate,
}: AvatarChipProps) {
  const folderName = folderLabel(cwd);
  const avatarStyle = useMemo(
    () =>
      ({
        "--offset": `${offset}px`,
        "--scale": scale,
        "--opacity": 1,
        zIndex: `${zIndex}`,
        ...(accentStyle ?? {}),
      }) as CSSProperties,
    [accentStyle, offset, scale, zIndex],
  );

  return (
    <button
      type="button"
      className={`avatar-chip ${isActive ? "avatar-chip-active" : ""}`}
      style={avatarStyle}
      onClick={() => onActivate(id)}
      aria-label={`Focus ${paneTitle(index)}`}
      title={`${avatar?.label ?? "Unassigned"} - ${folderName}${cwd ? ` (${cwd})` : ""}`}
    >
      <span className="avatar-folder" title={cwd ?? folderName}>
        {folderName}
      </span>
      <span className="avatar-image-wrap">
        {avatar ? (
          <img src={avatarSrcForState(avatar, avatarState)} alt={avatar.label} className="avatar-image" />
        ) : (
          <span className="avatar-fallback">{paneTitle(index).slice(-1)}</span>
        )}
        {avatarState === "idle" && <img src={idleIconUrl} alt="" className="avatar-state-badge avatar-badge-idle" />}
        {avatarState === "question" && (
          <img src={questionIconUrl} alt="" className="avatar-state-badge avatar-badge-question" />
        )}
      </span>
      <span className="avatar-name">{avatar?.label ?? "Unassigned"}</span>
    </button>
  );
});

AvatarChip.displayName = "AvatarChip";

interface PanePreviewProps {
  id: string;
  index: number;
  frame?: TerminalFrame;
  paneState: PaneRuntimeStatus;
  queuedCount: number;
  accentStyle?: CSSProperties;
  onActivate: (id: string) => void;
}

const PanePreview = memo(function PanePreview({
  id,
  index,
  frame,
  paneState,
  queuedCount,
  accentStyle,
  onActivate,
}: PanePreviewProps) {
  const previewText = useMemo(() => previewTextForPane(frame), [frame]);

  return (
    <section className="pane-shell pane-preview-shell" style={accentStyle}>
      <button
        type="button"
        className="pane-preview"
        onClick={() => onActivate(id)}
        aria-label={`Activate ${paneTitle(index)}`}
        title={`Activate ${paneTitle(index)}`}
      >
        <div className="pane-preview-meta">
          <span className="pane-preview-title">{paneTitle(index)}</span>
          <span className={`pane-preview-badge pane-preview-badge-${frame?.shellBusy ? "busy" : paneState}`}>
            {frame?.shellBusy ? "busy" : paneState}
          </span>
        </div>
        <div className="pane-preview-path">{frame?.cwd ?? "Starting session..."}</div>
        <pre className="pane-preview-text">{previewText}</pre>
        <div className="pane-preview-foot">
          <span>{frame?.altScreen ? "Interactive app" : "Shell view"}</span>
          <span>{queuedCount > 0 ? `${queuedCount} queued` : "Preview mode"}</span>
        </div>
      </button>
    </section>
  );
});

PanePreview.displayName = "PanePreview";

interface AvatarChipContainerProps {
  id: string;
  index: number;
  avatar?: AvatarDefinition;
  isActive: boolean;
  offset: number;
  scale: number;
  zIndex: number;
  accentStyle?: CSSProperties;
  onActivate: (id: string) => void;
}

const AvatarChipContainer = memo(function AvatarChipContainer(props: AvatarChipContainerProps) {
  const pane = usePaneRuntime(props.id);
  return <AvatarChip {...props} avatarState={pane.avatarState ?? "idle"} cwd={pane.frame?.cwd} />;
});

AvatarChipContainer.displayName = "AvatarChipContainer";

interface PanePreviewContainerProps {
  id: string;
  index: number;
  accentStyle?: CSSProperties;
  onActivate: (id: string) => void;
}

const PanePreviewContainer = memo(function PanePreviewContainer(props: PanePreviewContainerProps) {
  const pane = usePaneRuntime(props.id);
  return (
    <PanePreview
      {...props}
      frame={pane.frame}
      paneState={pane.status ?? "booting"}
      queuedCount={pane.queuedFrames?.length ?? 0}
    />
  );
});

PanePreviewContainer.displayName = "PanePreviewContainer";

interface ActiveTerminalPaneProps {
  id: string;
  rpc: RpcClient;
  active: boolean;
  accentStyle?: CSSProperties;
  shortcuts: DashboardConfig["shortcuts"];
  onActivate: (id: string) => void;
  onShortcut: (
    shortcut: "new-pane" | "focus-left" | "focus-right" | "move-left" | "move-right" | "close-pane" | "open-settings",
  ) => void;
  onFramesQueued: (id: string, lastSeq: number) => void;
  onUserInput: (id: string) => void;
}

const ActiveTerminalPane = memo(function ActiveTerminalPane(props: ActiveTerminalPaneProps) {
  const pane = usePaneRuntime(props.id);
  return <TerminalPane {...props} currentFrame={pane.frame} pendingFrames={pane.queuedFrames} />;
});

ActiveTerminalPane.displayName = "ActiveTerminalPane";

const StatusMetric = memo(function StatusMetric({ paneCount }: { paneCount: number }) {
  const frameCount = usePaneFrameCount();
  return <span className="status-metric">{paneCount} panes · {frameCount} active frames</span>;
});

StatusMetric.displayName = "StatusMetric";

function App() {
  const [paneIds, setPaneIds] = useState<string[]>([FIRST_ID]);
  const [status, setStatus] = useState("Connecting...");
  const [dashboardConfig, setDashboardConfig] = useState<DashboardConfig>(() =>
    cloneDashboardConfig(DEFAULT_DASHBOARD_CONFIG),
  );
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [inputPriorityActive, setInputPriorityActive] = useState(false);
  const [activePane, setActivePane] = useState(FIRST_ID);
  const [paneWidths, setPaneWidths] = useState<Record<string, number>>(() => loadStoredPaneWidths());
  const [paneAvatarIds, setPaneAvatarIds] = useState<Record<string, AvatarId>>(() =>
    assignUniqueAvatars([FIRST_ID]),
  );
  const [paneCwds, setPaneCwds] = useState<Record<string, string | undefined>>({});
  const [visiblePaneIds, setVisiblePaneIds] = useState<string[]>([FIRST_ID]);
  const [stripWidth, setStripWidth] = useState(0);
  const [avatarStripWidth, setAvatarStripWidth] = useState(0);
  const activePaneRef = useRef(FIRST_ID);
  const framesRef = useRef<Record<string, TerminalFrame>>({});
  const frameQueuesRef = useRef<Record<string, TerminalFrame[]>>({});
  const livePaneIdsRef = useRef<string[]>([FIRST_ID]);
  const paneStatusRef = useRef<Record<string, PaneRuntimeStatus>>({ [FIRST_ID]: "booting" });
  const avatarStatesRef = useRef<Record<string, AvatarVisualState>>({ [FIRST_ID]: "idle" });
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
  const liveFolderAccentSlotsRef = useRef<Record<string, number>>({});
  const historicalFolderAccentSlotsRef = useRef<Record<string, number>>({});
  const pendingFrameUpdatesRef = useRef<Record<string, PendingPaneFrameUpdate>>({});
  const pendingFrameFlushRafRef = useRef<number | null>(null);
  const inputPriorityTimerRef = useRef<number | null>(null);
  const inputPriorityActiveRef = useRef(false);
  const paneFlowPausedRef = useRef<Record<string, boolean>>({});
  const bootstrappedRef = useRef(false);
  const hasLaunchConfigRef = useRef(false);
  const hasDashboardConfigRef = useRef(false);
  const shortcuts = dashboardConfig.shortcuts;
  const defaultPaneWidth = dashboardConfig.defaultPaneWidth;
  const defaultPaneWidthRef = useRef(defaultPaneWidth);

  activePaneRef.current = activePane;
  paneIdsRef.current = paneIds;
  defaultPaneWidthRef.current = defaultPaneWidth;

  const livePaneIds = useMemo(
    () => selectLivePaneIds(paneIds, visiblePaneIds, activePane, dashboardConfig.visibleLivePanes),
    [activePane, dashboardConfig.visibleLivePanes, paneIds, visiblePaneIds],
  );
  const livePaneIdSet = useMemo(() => new Set(livePaneIds), [livePaneIds]);
  livePaneIdsRef.current = livePaneIds;

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

  const centerPaneWhenReady = useCallback(
    (id: string, behavior: ScrollBehavior = "smooth", attempts = 8) => {
      const node = paneSlotsRef.current[id];
      const strip = stripRef.current;
      if (node && strip && node.offsetWidth > 0) {
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            centerPane(id, behavior);
          });
        });
        return;
      }
      if (attempts <= 0) return;
      requestAnimationFrame(() => {
        centerPaneWhenReady(id, behavior, attempts - 1);
      });
    },
    [centerPane],
  );

  const setActivePaneCentered = useCallback(
    (id: string, behavior: ScrollBehavior = "smooth") => {
      setActivePane(id);
      centerPaneWhenReady(id, behavior);
    },
    [centerPaneWhenReady],
  );

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
    const strip = stripRef.current;
    if (!strip) return;

    let frame = 0;
    const measureVisiblePanes = () => {
      frame = 0;
      const stripRect = strip.getBoundingClientRect();
      const nextVisible = paneIds.filter((id) => {
        const node = paneSlotsRef.current[id];
        if (!node) return false;
        const rect = node.getBoundingClientRect();
        const overlap = Math.max(0, Math.min(rect.right, stripRect.right) - Math.max(rect.left, stripRect.left));
        if (overlap <= 0 || rect.width <= 0) return false;
        return overlap / rect.width >= VISIBLE_PANE_INTERSECTION_RATIO;
      });

      setVisiblePaneIds((prev) => {
        if (prev.length === nextVisible.length && prev.every((id, index) => id === nextVisible[index])) {
          return prev;
        }
        return nextVisible.length > 0 ? nextVisible : [activePaneRef.current];
      });
    };

    const scheduleMeasure = () => {
      if (frame) return;
      frame = window.requestAnimationFrame(measureVisiblePanes);
    };

    scheduleMeasure();
    strip.addEventListener("scroll", scheduleMeasure, { passive: true });
    window.addEventListener("resize", scheduleMeasure);
    const observer = new ResizeObserver(scheduleMeasure);
    observer.observe(strip);
    for (const id of paneIds) {
      const node = paneSlotsRef.current[id];
      if (node) observer.observe(node);
    }

    return () => {
      strip.removeEventListener("scroll", scheduleMeasure);
      window.removeEventListener("resize", scheduleMeasure);
      observer.disconnect();
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, [paneIds, paneWidths]);

  useEffect(() => {
    const avatarStrip = avatarStripRef.current;
    if (!avatarStrip) return;
    const syncWidth = () => setAvatarStripWidth(avatarStrip.clientWidth);
    syncWidth();
    const observer = new ResizeObserver(syncWidth);
    observer.observe(avatarStrip);
    return () => observer.disconnect();
  }, []);

  const createTerminal = useCallback((
    id: string,
    launch?: PaneLaunchConfig,
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
    paneStatusRef.current = statusInit;
    setPaneWidths((prev) => {
      const next: Record<string, number> = {};
      for (const id of ids) {
        next[id] = prev[id] ?? defaultPaneWidthRef.current;
      }
      return next;
    });
    setPaneAvatarIds(assignUniqueAvatars(ids));
    setPaneCwds({});
    framesRef.current = {};
    frameQueuesRef.current = {};
    avatarStatesRef.current = Object.fromEntries(ids.map((id) => [id, "idle" as const]));
    paneRuntimeStore.replaceAll(
      Object.fromEntries(
        ids.map((id) => [id, { status: "booting" as const, avatarState: "idle" as const }]),
      ),
    );
    avatarActivityRef.current = {};
    const firstId = ids[0] ?? FIRST_ID;
    setActivePaneCentered(firstId, "auto");
    safeLaunchPanes.forEach((launch, index) => {
      createTerminal(ids[index], launch);
    });
  }, [createTerminal, setActivePaneCentered]);

  const maybeBootstrapTerminals = useCallback(() => {
    if (bootstrappedRef.current) return;
    if (!hasLaunchConfigRef.current || !hasDashboardConfigRef.current) return;
    bootstrappedRef.current = true;
    ensureBootstrapTerminals();
  }, [ensureBootstrapTerminals]);

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
    setPaneIds((prev) => {
      const activeIndex = prev.indexOf(activePaneRef.current);
      if (activeIndex < 0) return [...prev, id];
      const next = [...prev];
      next.splice(activeIndex + 1, 0, id);
      return next;
    });
    paneStatusRef.current = { ...paneStatusRef.current, [id]: "booting" };
    setPaneWidths((prev) => ({ ...prev, [id]: defaultPaneWidth }));
    setPaneAvatarIds((prev) => {
      const used = new Set(Object.values(prev));
      const avatarId = pickAvailableAvatar(used);
      if (!avatarId) return prev;
      return { ...prev, [id]: avatarId };
    });
    avatarStatesRef.current = { ...avatarStatesRef.current, [id]: "idle" };
    paneRuntimeStore.patchPane(id, { status: "booting", avatarState: "idle", queuedFrames: [] });
    setActivePaneCentered(id);
    createTerminal(id);
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

  const reorderActivePane = useCallback(
    (direction: "left" | "right") => {
      const ids = paneIdsRef.current;
      if (ids.length < 2) return;
      const currentIndex = ids.indexOf(activePaneRef.current);
      if (currentIndex < 0) return;
      const targetIndex = direction === "left" ? currentIndex - 1 : currentIndex + 1;
      if (targetIndex < 0 || targetIndex >= ids.length) return;

      setPaneIds((prev) => {
        const from = prev.indexOf(activePaneRef.current);
        if (from < 0) return prev;
        const to = direction === "left" ? from - 1 : from + 1;
        if (to < 0 || to >= prev.length) return prev;
        const next = [...prev];
        const [moved] = next.splice(from, 1);
        next.splice(to, 0, moved);
        return next;
      });

      requestAnimationFrame(() => {
        centerPaneWhenReady(activePaneRef.current, "smooth");
      });
    },
    [centerPaneWhenReady],
  );

  const openSettings = useCallback(() => {
    setSettingsOpen(true);
  }, []);

  const closeActivePane = useCallback(() => {
    const id = activePaneRef.current;
    if (!id) return;
    rpc.send({ type: "kill", id });
    setStatus(`Closing ${id}...`);
  }, []);

  const saveDashboardConfig = useCallback((nextConfig: DashboardConfig) => {
    setDashboardConfig(nextConfig);
    rpc.send({ type: "set-config", config: nextConfig });
    setStatus("Settings saved");
  }, []);

  const handlePaneShortcut = useCallback(
    (
      shortcut: "new-pane" | "focus-left" | "focus-right" | "move-left" | "move-right" | "close-pane" | "open-settings",
    ) => {
      if (shortcut === "new-pane") {
        addTerminalPane();
        return;
      }
      if (shortcut === "move-left" || shortcut === "move-right") {
        reorderActivePane(shortcut === "move-right" ? "right" : "left");
        return;
      }
      if (shortcut === "close-pane") {
        closeActivePane();
        return;
      }
      if (shortcut === "open-settings") {
        openSettings();
        return;
      }
      moveActivePane(shortcut === "focus-right" ? "right" : "left");
    },
    [addTerminalPane, closeActivePane, moveActivePane, openSettings, reorderActivePane],
  );

  const handlePaneUserInput = useCallback((id: string) => {
    if (id !== activePaneRef.current) return;
    if (!inputPriorityActiveRef.current) {
      inputPriorityActiveRef.current = true;
      setInputPriorityActive(true);
    }
    if (inputPriorityTimerRef.current != null) {
      window.clearTimeout(inputPriorityTimerRef.current);
    }
    inputPriorityTimerRef.current = window.setTimeout(() => {
      inputPriorityTimerRef.current = null;
      inputPriorityActiveRef.current = false;
      setInputPriorityActive(false);
    }, ACTIVE_INPUT_FLOW_HOLD_MS);
  }, []);

  const flushPendingFrames = useCallback(() => {
    pendingFrameFlushRafRef.current = null;
    const pending = pendingFrameUpdatesRef.current;
    pendingFrameUpdatesRef.current = {};
    const entries = Object.entries(pending);
    if (entries.length === 0) return;

    const nowMs = Date.now();
    const nextFrames = { ...framesRef.current };
    const nextFrameQueues = { ...frameQueuesRef.current };
    const nextAvatarStates = { ...avatarStatesRef.current };
    const nextPaneStatus = { ...paneStatusRef.current };
    const runtimeUpdates: Record<string, PaneRuntimeState> = {};
    const cwdUpdates: Record<string, string | undefined> = {};

    for (const [id, update] of entries) {
      const activityFrame = update.activityFrame;
      const resolved = nextAvatarActivity(activityFrame, avatarActivityRef.current[id], nowMs);
      avatarActivityRef.current[id] = resolved.activity;
      nextFrames[id] = activityFrame;
      if (update.renderFrames.length > 0 && livePaneIdsRef.current.includes(id)) {
        nextFrameQueues[id] = update.renderFrames;
      } else {
        delete nextFrameQueues[id];
      }
      nextAvatarStates[id] = resolved.displayState;
      if (nextPaneStatus[id] !== "running") {
        nextPaneStatus[id] = "running";
      }
      runtimeUpdates[id] = {
        frame: activityFrame,
        queuedFrames: nextFrameQueues[id] ?? [],
        avatarState: resolved.displayState,
        status: nextPaneStatus[id] ?? "running",
      };
      cwdUpdates[id] = activityFrame.cwd;
    }

    framesRef.current = nextFrames;
    frameQueuesRef.current = nextFrameQueues;
    avatarStatesRef.current = nextAvatarStates;
    paneStatusRef.current = nextPaneStatus;
    paneRuntimeStore.patchMany(runtimeUpdates);
    setPaneCwds((prev) => {
      let changed = false;
      const next = { ...prev };
      for (const [id, cwd] of Object.entries(cwdUpdates)) {
        if (next[id] === cwd) continue;
        next[id] = cwd;
        changed = true;
      }
      return changed ? next : prev;
    });
    setStatus("Connected");
  }, []);

  useEffect(() => {
    const disposeReady = rpc.onReady(() => {
      setStatus("Connected");
      rpc.send({ type: "launch-config" });
      rpc.send({ type: "get-config" });
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
      paneStatusRef.current = { ...paneStatusRef.current, [id]: "running" };
      paneRuntimeStore.patchPane(id, { status: "running" });
      setStatus("Connected");
    });
    const disposeFrame = rpc.onFrame((frame) => {
      const activityFrame = compactFrameForActivity(frame);
      const renderFrame = compactFrameForRender(frame);
      const pending = pendingFrameUpdatesRef.current[frame.id];
      const baseActivityFrame = pending?.activityFrame ?? framesRef.current[frame.id];
      const shouldQueueRenderFrames = livePaneIdsRef.current.includes(frame.id);
      const baseRenderFrames = shouldQueueRenderFrames
        ? pending?.renderFrames ?? frameQueuesRef.current[frame.id] ?? []
        : [];
      pendingFrameUpdatesRef.current[frame.id] = {
        activityFrame: mergeActivityFrame(baseActivityFrame, activityFrame),
        renderFrames: shouldQueueRenderFrames ? coalesceQueuedRenderFrames(baseRenderFrames, renderFrame) : [],
      };
      if (pendingFrameFlushRafRef.current == null) {
        pendingFrameFlushRafRef.current = window.requestAnimationFrame(flushPendingFrames);
      }
    });
    const disposeError = rpc.onError((message) => {
      setStatus(`RPC error: ${message}`);
      const id = activePaneRef.current;
      paneStatusRef.current = { ...paneStatusRef.current, [id]: "error" };
      paneRuntimeStore.patchPane(id, { status: "error" });
    });
    const disposeExit = rpc.onExit((id, code) => {
      setStatus(`${id} exited (${code})`);
      delete pendingFrameUpdatesRef.current[id];
      delete avatarActivityRef.current[id];
      delete framesRef.current[id];
      delete frameQueuesRef.current[id];
      delete avatarStatesRef.current[id];
      delete paneStatusRef.current[id];
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
      setPaneAvatarIds((prev) => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
      setPaneWidths((prev) => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
      setPaneCwds((prev) => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
      paneRuntimeStore.removePane(id);
    });

    rpc.send({ type: "launch-config" });
    rpc.send({ type: "get-config" });

    return () => {
      if (pendingFrameFlushRafRef.current != null) {
        window.cancelAnimationFrame(pendingFrameFlushRafRef.current);
        pendingFrameFlushRafRef.current = null;
      }
      if (inputPriorityTimerRef.current != null) {
        window.clearTimeout(inputPriorityTimerRef.current);
        inputPriorityTimerRef.current = null;
      }
      disposeReady();
      disposeConfig();
      disposeLaunchConfig();
      disposeCreated();
      disposeFrame();
      disposeError();
      disposeExit();
    };
  }, [flushPendingFrames, maybeBootstrapTerminals, setActivePaneCentered]);

  useEffect(() => {
    const paneIdSet = new Set(paneIds);
    for (const id of Object.keys(paneFlowPausedRef.current)) {
      if (!paneIdSet.has(id)) delete paneFlowPausedRef.current[id];
    }

    for (const id of paneIds) {
      const paused = inputPriorityActive && id !== activePane;
      if (paneFlowPausedRef.current[id] === paused) continue;
      paneFlowPausedRef.current[id] = paused;
      rpc.send({ type: "flow", id, paused });
    }
  }, [activePane, inputPriorityActive, paneIds]);

  const handleFramesQueued = useCallback((id: string, lastSeq: number) => {
    const pending = frameQueuesRef.current[id];
    if (!pending?.length) return;
    const nextPending = pending.filter((frame) => frame.seq > lastSeq);
    if (nextPending.length === pending.length) return;
    if (nextPending.length === 0) {
      const next = { ...frameQueuesRef.current };
      delete next[id];
      frameQueuesRef.current = next;
      paneRuntimeStore.patchPane(id, { queuedFrames: [] });
      return;
    }
    const next = { ...frameQueuesRef.current, [id]: nextPending };
    frameQueuesRef.current = next;
    paneRuntimeStore.patchPane(id, { queuedFrames: nextPending });
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
        return;
      }
      if (doesEventMatchShortcut(event, shortcuts.movePaneLeft)) {
        event.preventDefault();
        reorderActivePane("left");
        return;
      }
      if (doesEventMatchShortcut(event, shortcuts.movePaneRight)) {
        event.preventDefault();
        reorderActivePane("right");
        return;
      }
      if (doesEventMatchShortcut(event, shortcuts.closePane)) {
        event.preventDefault();
        closeActivePane();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [addTerminalPane, closeActivePane, moveActivePane, openSettings, reorderActivePane, settingsOpen, shortcuts]);

  useEffect(() => {
    const onPaste = (event: ClipboardEvent) => {
      if (event.defaultPrevented) return;
      if (settingsOpen) return;
      const imageFile = firstImageClipboardFile(event.clipboardData);
      if (imageFile) {
        if (isEditableEventTarget(event.target) && !isTerminalPasteTarget(event.target)) return;
        const id = activePaneRef.current;
        if (!id) return;
        event.preventDefault();
        handlePaneUserInput(id);
        void (async () => {
          try {
            const dataBase64 = await readFileAsBase64(imageFile);
            rpc.send({
              type: "paste-image",
              id,
              dataBase64,
              mimeType: imageFile.type || "image/png",
              fileName: imageFile.name,
            });
            setStatus("Image pasted as file path");
          } catch (error) {
            setStatus(`Image paste failed: ${error instanceof Error ? error.message : "Unknown error"}`);
          }
        })();
        return;
      }

      if (isEditableEventTarget(event.target)) return;
      const text = event.clipboardData?.getData("text/plain");
      if (!text) return;
      const id = activePaneRef.current;
      if (!id) return;
      event.preventDefault();
      handlePaneUserInput(id);
      rpc.send({ type: "input", id, data: text, encoding: "utf8" });
    };

    window.addEventListener("paste", onPaste, true);
    return () => window.removeEventListener("paste", onPaste, true);
  }, [handlePaneUserInput, settingsOpen]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      const nowMs = Date.now();
      const nextAvatarStates = { ...avatarStatesRef.current };
      const runtimeUpdates: Record<string, PaneRuntimeState> = {};
      let changed = false;
      for (const [id, currentState] of Object.entries(avatarStatesRef.current)) {
        if (currentState !== "working") continue;
        const activity = avatarActivityRef.current[id];
        const frame = framesRef.current[id];
        const nextState = resolveAvatarDisplayState(frame, activity, nowMs);
        if (nextState === currentState) continue;
        nextAvatarStates[id] = nextState;
        runtimeUpdates[id] = { avatarState: nextState };
        changed = true;
        if (activity) {
          avatarActivityRef.current[id] = {
            ...activity,
            state: nextState,
          };
        }
      }
      if (!changed) return;
      avatarStatesRef.current = nextAvatarStates;
      paneRuntimeStore.patchMany(runtimeUpdates);
    }, 400);
    return () => window.clearInterval(timer);
  }, []);

  const backgroundFrameIntervalMs = useMemo(
    () => backgroundFrameIntervalForPaneCount(paneIds.length),
    [paneIds.length],
  );

  useEffect(() => {
    const previousQueues = frameQueuesRef.current;
    let changed = false;
    const next: Record<string, TerminalFrame[]> = {};
    const runtimeUpdates: Record<string, PaneRuntimeState> = {};
    const livePaneSet = new Set(livePaneIds);
    for (const [id, queue] of Object.entries(previousQueues)) {
      if (livePaneSet.has(id)) {
        if (queue?.length) {
          next[id] = queue;
        }
        continue;
      }
      if (!queue?.length) continue;
      changed = true;
      runtimeUpdates[id] = { queuedFrames: [] };
    }
    for (const id of livePaneIds) {
      const queue = next[id] ?? [];
      runtimeUpdates[id] = { queuedFrames: queue };
    }
    if (changed || livePaneIds.some((id) => previousQueues[id] !== next[id])) {
      frameQueuesRef.current = next;
      paneRuntimeStore.patchMany(runtimeUpdates);
    } else if (Object.keys(runtimeUpdates).length > 0) {
      paneRuntimeStore.patchMany(runtimeUpdates);
    }

    for (const id of paneIds) {
      const isLive = livePaneSet.has(id);
      rpc.send({
        type: "frame-rate",
        id,
        intervalMs: id === activePane ? 0 : isLive ? LIVE_VISIBLE_PANE_FRAME_INTERVAL_MS : backgroundFrameIntervalMs,
        previewOnly: !isLive,
      });
    }
    for (const id of livePaneIds) {
      rpc.send({ type: "snapshot", id });
    }
  }, [activePane, backgroundFrameIntervalMs, livePaneIds, paneIds]);

  useEffect(() => {
    centerPaneWhenReady(activePane, "smooth");
  }, [activePane, centerPaneWhenReady]);

  useLayoutEffect(() => {
    if (!activePane) return;
    centerPaneWhenReady(activePane, "auto");
  }, [activePane, paneIds, paneWidths, stripWidth, centerPaneWhenReady]);

  useEffect(() => {
    const firstId = paneIds[0];
    if (!firstId) return;
    requestAnimationFrame(() => {
      centerPaneWhenReady(activePaneRef.current || firstId, "auto");
    });
  }, [paneIds, stripWidth, centerPaneWhenReady]);

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
      centerPaneWhenReady(activePaneRef.current, "auto");
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      document.body.classList.remove("pane-resize-active");
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [centerPaneWhenReady]);

  const rpcReady = status !== "Connecting..." && !status.startsWith("RPC error");
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
    const usableHalf = Math.max(0, avatarStripWidth / 2 - chipWidth / 2 - edgePadding);
    const leftCount = activeAvatarIndex;
    const rightCount = Math.max(0, paneIds.length - activeAvatarIndex - 1);
    const edgeOffset = Math.max(0, usableHalf - 10);
    const minCenterGap = chipWidth + 18;

    const buildSide = (count: number) => {
      if (count <= 0) return { base: 0, step: 0 };
      if (count === 1) return { base: edgeOffset, step: 0 };

      const availableSpan = Math.max(0, edgeOffset - minCenterGap);
      const idealStep = chipWidth + 14;
      const step = Math.min(idealStep, availableSpan / (count - 1));
      const base = edgeOffset - step * (count - 1);
      return { base, step };
    };

    return {
      left: buildSide(leftCount),
      right: buildSide(rightCount),
    };
  }, [activeAvatarIndex, avatarStripWidth, paneIds.length]);
  const paneCwdSignature = paneIds.map((id) => paneCwds[id] ?? "").join("\n");
  const paneAccentStyles = useMemo(() => {
    const folderKeys = paneIds.map((id) => folderAccentKey(paneCwds[id]));
    const next = resolveFolderAccentAssignments(
      folderKeys,
      liveFolderAccentSlotsRef.current,
      historicalFolderAccentSlotsRef.current,
    );
    liveFolderAccentSlotsRef.current = next.liveAssignments;
    historicalFolderAccentSlotsRef.current = next.historicalAssignments;

    const out: Record<string, CSSProperties> = {};
    for (const id of paneIds) {
      const key = folderAccentKey(paneCwds[id]);
      const slot = next.liveAssignments[key] ?? 0;
      out[id] = ACCENT_STYLE_BY_SLOT[slot] ?? ACCENT_STYLE_BY_SLOT[0];
    }
    return out;
  }, [paneCwdSignature, paneIds]);

  return (
    <main className="app-shell">
      <header className="topbar topbar-compact">
        <span
          className={`status-orb ${rpcReady ? "status-orb-ready" : "status-orb-down"}`}
          title={
            rpcReady
              ? "Local terminal backend connected."
              : `Local terminal backend not ready: ${status}`
          }
          aria-label={rpcReady ? "Local terminal backend connected" : "Local terminal backend disconnected"}
        />
        <div className="topbar-meta">
          <StatusMetric paneCount={paneIds.length} />
          <div className="shortcut-cluster" aria-label="Keyboard shortcuts">
            <span className="shortcut-pill">
              <span className="shortcut-label">Add</span>
              <kbd>{shortcuts.addPane}</kbd>
            </span>
            <span className="shortcut-pill">
              <span className="shortcut-label">Focus</span>
              <kbd>{shortcuts.focusPrevPane}</kbd>
              <span className="shortcut-divider">/</span>
              <kbd>{shortcuts.focusNextPane}</kbd>
            </span>
            <span className="shortcut-pill">
              <span className="shortcut-label">Move</span>
              <kbd>{shortcuts.movePaneLeft}</kbd>
              <span className="shortcut-divider">/</span>
              <kbd>{shortcuts.movePaneRight}</kbd>
            </span>
            <span className="shortcut-pill">
              <span className="shortcut-label">Close</span>
              <kbd>{shortcuts.closePane}</kbd>
            </span>
          </div>
        </div>
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
            const isActive = activePane === id;
            const relative = index - activeAvatarIndex;
            const direction = relative === 0 ? 0 : relative > 0 ? 1 : -1;
            const sideRank =
              direction < 0 ? activeAvatarIndex - index - 1 : direction > 0 ? index - activeAvatarIndex - 1 : 0;
            const spread =
              direction === 0
                ? 0
                : direction < 0
                  ? avatarLayout.left.base + sideRank * avatarLayout.left.step
                  : avatarLayout.right.base + sideRank * avatarLayout.right.step;
            const offset = direction * spread;
            const distance = Math.abs(relative);
            const scale = isActive ? 1 : Math.max(0.72, 0.9 - distance * 0.11);

            return (
              <AvatarChipContainer
                key={`avatar-${id}`}
                id={id}
                index={index}
                avatar={avatar}
                isActive={isActive}
                offset={offset}
                scale={scale}
                zIndex={120 - distance}
                accentStyle={paneAccentStyles[id]}
                onActivate={setActivePaneCentered}
              />
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
            {livePaneIdSet.has(id) ? (
              <ActiveTerminalPane
                id={id}
                rpc={rpc}
                active={activePane === id}
                accentStyle={paneAccentStyles[id]}
                shortcuts={shortcuts}
                onActivate={setActivePaneCentered}
                onFramesQueued={handleFramesQueued}
                onShortcut={handlePaneShortcut}
                onUserInput={handlePaneUserInput}
              />
            ) : (
              <PanePreviewContainer
                id={id}
                index={index}
                accentStyle={paneAccentStyles[id]}
                onActivate={setActivePaneCentered}
              />
            )}
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
