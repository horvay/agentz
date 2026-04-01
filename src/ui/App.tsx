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
import { resolveAvatarDisplayState, type AvatarActivityState } from "./avatarState";
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
import { folderLabel, resolveNewPaneCwd, resolvePaneCwdFromFrame } from "./paneCwd";
import { coalesceQueuedRenderFrames } from "./renderQueues";
import { doesEventMatchShortcut } from "./shortcuts";
import { selectLivePaneIds } from "./livePaneSelection";
import { recoverTerminalLayout } from "./terminalRecovery";
import { assignPaneAvatars, pickDeterministicAvatar } from "./avatarAssignments";
import { dispatchTerminalTextPaste } from "./terminalTextPaste";
import idleIconUrl from "../../assets/icons/idle.svg";
import questionIconUrl from "../../assets/icons/question.svg";

function resolveRpcUrl(): string {
  return "ws://127.0.0.1:4599";
  // Remote RPC connections are intentionally disabled until the transport is secured.
  // if (typeof window === "undefined") {
  //   return "ws://127.0.0.1:4599";
  // }
  //
  // const { hostname, protocol } = window.location;
  // if (!hostname) {
  //   return "ws://127.0.0.1:4599";
  // }
  //
  // const wsProtocol = protocol === "https:" ? "wss:" : "ws:";
  // return `${wsProtocol}//${hostname}:4599`;
}

const rpc = new RpcClient(resolveRpcUrl());
const FIRST_ID = "term-1";
const BACKGROUND_TERMINAL_SUFFIX = "-bg";
const WIDTH_STORAGE_KEY = "agentz.paneWidths.v1";
const MAX_AVATAR_PANES = avatarCatalog.length;
const MAX_ACTIVITY_CHUNK_CHARS = 4_000;
const MAX_ACTIVITY_VT_CHARS = 4_000;
const ACTIVE_INPUT_FLOW_HOLD_MS = 180;
const PANE_CENTER_ANIMATION_MS = 160;
const LIVE_VISIBLE_PANE_FRAME_INTERVAL_MS = 90;
const VISIBLE_PANE_INTERSECTION_RATIO = 0.2;
const AVATAR_IDS = avatarCatalog.map((avatar) => avatar.id);
const avatarById: Record<AvatarId, AvatarDefinition> = Object.fromEntries(
  avatarCatalog.map((avatar) => [avatar.id, avatar]),
) as Record<AvatarId, AvatarDefinition>;
type BackgroundTerminalMap = Record<string, string[]>;

function paneTitle(index: number): string {
  if (index < 26) return `Pane ${String.fromCharCode(65 + index)}`;
  return `Pane ${index + 1}`;
}

function parseBackgroundTerminalId(id: string): { paneId: string; ordinal: number } | null {
  const match = /^(term-\d+)-bg(?:-(\d+))?$/.exec(id);
  if (!match) return null;
  const paneId = match[1];
  if (!paneId) return null;
  const ordinal = match[2] ? Number(match[2]) : 1;
  return Number.isFinite(ordinal) ? { paneId, ordinal } : null;
}

function backgroundTerminalIdForPane(id: string, ordinal = 1): string {
  return ordinal <= 1 ? `${id}${BACKGROUND_TERMINAL_SUFFIX}` : `${id}${BACKGROUND_TERMINAL_SUFFIX}-${ordinal}`;
}

function sortBackgroundTerminalIds(ids: string[]): string[] {
  return [...ids].sort((a, b) => {
    const aOrdinal = parseBackgroundTerminalId(a)?.ordinal ?? 1;
    const bOrdinal = parseBackgroundTerminalId(b)?.ordinal ?? 1;
    return aOrdinal - bOrdinal;
  });
}

function nextBackgroundTerminalOrdinal(ids: string[]): number {
  return ids.reduce((maxOrdinal, id) => Math.max(maxOrdinal, parseBackgroundTerminalId(id)?.ordinal ?? 1), 0) + 1;
}

function visibleSessionIdForPane(
  paneId: string,
  backgroundIds: string[] | undefined,
  visibleSessionId: string | undefined,
): string {
  if (visibleSessionId === paneId) return paneId;
  if (visibleSessionId && (backgroundIds ?? []).includes(visibleSessionId)) return visibleSessionId;
  return paneId;
}

function paneSessionIds(paneId: string, backgroundIds: string[] | undefined): string[] {
  return [paneId, ...(backgroundIds ?? [])];
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

function assignUniqueAvatars(ids: string[]): Record<string, AvatarId> {
  return assignPaneAvatars(ids, AVATAR_IDS);
}

function pickAvailableAvatar(paneId: string, used: Set<AvatarId>): AvatarId | null {
  return pickDeterministicAvatar(paneId, AVATAR_IDS, used);
}

function avatarSrcForState(avatar: AvatarDefinition, state: AvatarVisualState): string {
  if (state === "working") return avatar.workingSrc;
  if (state === "question") return avatar.questionSrc;
  if (state === "calling") return avatar.callingSrc;
  return avatar.idleSrc;
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
    bracketedPasteMode: frame.bracketedPasteMode,
  };
}

function nextAvatarActivityState(
  frame: TerminalFrame | undefined,
  previous: AvatarActivityState | undefined,
  nowMs: number,
): AvatarActivityState {
  const previewText = (frame?.previewLines ?? []).join("\n");
  const previewChanged = previous !== undefined && previewText !== previous.lastPreviewText;
  return {
    lastPreviewText: previewText,
    lastPreviewChangeAtMs: previewChanged ? nowMs : previous?.lastPreviewChangeAtMs,
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
    bracketedPasteMode: frame.bracketedPasteMode,
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
    cursorVisible: next.cursorVisible ?? existing.cursorVisible,
    cursorStyle: next.cursorStyle ?? existing.cursorStyle,
    cursorBlink: next.cursorBlink ?? existing.cursorBlink,
    cursorRow: next.cursorRow ?? existing.cursorRow,
    cursorCol: next.cursorCol ?? existing.cursorCol,
    mouseTrackingMode: next.mouseTrackingMode ?? existing.mouseTrackingMode,
    mouseFormat: next.mouseFormat ?? existing.mouseFormat,
    focusEvent: next.focusEvent ?? existing.focusEvent,
    mouseAlternateScroll: next.mouseAlternateScroll ?? existing.mouseAlternateScroll,
    bracketedPasteMode: next.bracketedPasteMode ?? existing.bracketedPasteMode,
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
  paneId: string;
  index: number;
  frame?: TerminalFrame;
  paneState: PaneRuntimeStatus;
  queuedCount: number;
  accentStyle?: CSSProperties;
  onActivate: (id: string) => void;
}

const PanePreview = memo(function PanePreview({
  paneId,
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
        onClick={() => onActivate(paneId)}
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
  paneId: string;
  sessionId: string;
  index: number;
  accentStyle?: CSSProperties;
  onActivate: (id: string) => void;
}

const PanePreviewContainer = memo(function PanePreviewContainer(props: PanePreviewContainerProps) {
  const pane = usePaneRuntime(props.sessionId);
  return (
    <PanePreview
      paneId={props.paneId}
      index={props.index}
      frame={pane.frame}
      paneState={pane.status ?? "booting"}
      queuedCount={pane.queuedFrames?.length ?? 0}
      accentStyle={props.accentStyle}
      onActivate={props.onActivate}
    />
  );
});

PanePreviewContainer.displayName = "PanePreviewContainer";

interface ActiveTerminalPaneProps {
  paneId: string;
  sessionId: string;
  rpc: RpcClient;
  active: boolean;
  accentStyle?: CSSProperties;
  shortcuts: DashboardConfig["shortcuts"];
  onActivate: (id: string) => void;
  onShortcut: (
    shortcut:
      | "new-pane"
      | "toggle-background"
      | "new-background"
      | "focus-left"
      | "focus-right"
      | "move-left"
      | "move-right"
      | "close-pane"
      | "open-settings",
  ) => void;
  onFramesQueued: (id: string, lastSeq: number) => void;
  onUserInput: (id: string) => void;
  onTextPasteRegister: (id: string, handler: ((text: string) => void) | null) => void;
}

const ActiveTerminalPane = memo(function ActiveTerminalPane(props: ActiveTerminalPaneProps) {
  const pane = usePaneRuntime(props.sessionId);
  return (
    <TerminalPane
      id={props.sessionId}
      rpc={props.rpc}
      currentFrame={pane.frame}
      pendingFrames={pane.queuedFrames}
      active={props.active}
      accentStyle={props.accentStyle}
      shortcuts={props.shortcuts}
      onActivate={() => props.onActivate(props.paneId)}
      onShortcut={props.onShortcut}
      onFramesQueued={props.onFramesQueued}
      onUserInput={props.onUserInput}
      onTextPasteRegister={props.onTextPasteRegister}
    />
  );
});

ActiveTerminalPane.displayName = "ActiveTerminalPane";

interface PaneSurfaceContainerProps {
  paneId: string;
  sessionId: string;
  index: number;
  live: boolean;
  active: boolean;
  accentStyle?: CSSProperties;
  shortcuts: DashboardConfig["shortcuts"];
  onActivate: (id: string) => void;
  onShortcut: (
    shortcut:
      | "new-pane"
      | "toggle-background"
      | "new-background"
      | "focus-left"
      | "focus-right"
      | "move-left"
      | "move-right"
      | "close-pane"
      | "open-settings",
  ) => void;
  onFramesQueued: (id: string, lastSeq: number) => void;
  onUserInput: (id: string) => void;
  onTextPasteRegister: (id: string, handler: ((text: string) => void) | null) => void;
}

const PaneSurfaceContainer = memo(function PaneSurfaceContainer(props: PaneSurfaceContainerProps) {
  if (props.live) {
    return (
      <ActiveTerminalPane
        paneId={props.paneId}
        sessionId={props.sessionId}
        rpc={rpc}
        active={props.active}
        accentStyle={props.accentStyle}
        shortcuts={props.shortcuts}
        onActivate={props.onActivate}
        onFramesQueued={props.onFramesQueued}
        onShortcut={props.onShortcut}
        onUserInput={props.onUserInput}
        onTextPasteRegister={props.onTextPasteRegister}
      />
    );
  }

  return (
    <PanePreviewContainer
      paneId={props.paneId}
      sessionId={props.sessionId}
      index={props.index}
      accentStyle={props.accentStyle}
      onActivate={props.onActivate}
    />
  );
});

PaneSurfaceContainer.displayName = "PaneSurfaceContainer";

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
  const [backgroundTerminalIds, setBackgroundTerminalIds] = useState<BackgroundTerminalMap>({});
  const [visibleSessionIds, setVisibleSessionIds] = useState<Record<string, string>>({});
  const [paneCwds, setPaneCwds] = useState<Record<string, string | undefined>>({});
  const [paneStackFlipNonce, setPaneStackFlipNonce] = useState<Record<string, number>>({});
  const [visiblePaneIds, setVisiblePaneIds] = useState<string[]>([FIRST_ID]);
  const [stripWidth, setStripWidth] = useState(0);
  const [avatarStripWidth, setAvatarStripWidth] = useState(0);
  const activePaneRef = useRef(FIRST_ID);
  const framesRef = useRef<Record<string, TerminalFrame>>({});
  const frameQueuesRef = useRef<Record<string, TerminalFrame[]>>({});
  const renderableSessionIdsRef = useRef<string[]>([FIRST_ID]);
  const paneStatusRef = useRef<Record<string, PaneRuntimeStatus>>({ [FIRST_ID]: "booting" });
  const avatarStatesRef = useRef<Record<string, AvatarVisualState>>({ [FIRST_ID]: "idle" });
  const paneIdsRef = useRef<string[]>([FIRST_ID]);
  const backgroundTerminalIdsRef = useRef<BackgroundTerminalMap>({});
  const visibleSessionIdsRef = useRef<Record<string, string>>({});
  const paneCwdsRef = useRef<Record<string, string | undefined>>({});
  const nextPaneOrdinalRef = useRef(2);
  const launchConfigRef = useRef<LaunchConfig>({});
  const createdIdsRef = useRef(new Set<string>());
  const activeSessionIdRef = useRef(FIRST_ID);
  const centerScrollAnimationRef = useRef<number | null>(null);
  const paneSlotsRef = useRef<Record<string, HTMLDivElement | null>>({});
  const avatarStripRef = useRef<HTMLDivElement>(null);
  const stripRef = useRef<HTMLDivElement>(null);
  const resizeDragRef = useRef<{ id: string; startX: number; startWidth: number } | null>(null);
  const avatarActivityRef = useRef<Record<string, AvatarActivityState>>({});
  const liveFolderAccentSlotsRef = useRef<Record<string, number>>({});
  const historicalFolderAccentSlotsRef = useRef<Record<string, number>>({});
  const pendingFrameUpdatesRef = useRef<Record<string, PendingPaneFrameUpdate>>({});
  const pendingFrameFlushRafRef = useRef<number | null>(null);
  const inputPriorityTimerRef = useRef<number | null>(null);
  const inputPriorityActiveRef = useRef(false);
  const paneFlowPausedRef = useRef<Record<string, boolean>>({});
  const paneTextPasteHandlersRef = useRef<Record<string, (text: string) => void>>({});
  const bootstrappedRef = useRef(false);
  const hasLaunchConfigRef = useRef(false);
  const hasDashboardConfigRef = useRef(false);
  const hasTerminalListRef = useRef(false);
  const serverTerminalIdsRef = useRef<string[]>([]);
  const shortcuts = dashboardConfig.shortcuts;
  const defaultPaneWidth = dashboardConfig.defaultPaneWidth;
  const defaultPaneWidthRef = useRef(defaultPaneWidth);

  activePaneRef.current = activePane;
  paneIdsRef.current = paneIds;
  backgroundTerminalIdsRef.current = backgroundTerminalIds;
  visibleSessionIdsRef.current = visibleSessionIds;
  paneCwdsRef.current = paneCwds;
  defaultPaneWidthRef.current = defaultPaneWidth;

  const livePaneIds = useMemo(
    () => selectLivePaneIds(paneIds, visiblePaneIds, activePane, dashboardConfig.visibleLivePanes),
    [activePane, dashboardConfig.visibleLivePanes, paneIds, visiblePaneIds],
  );
  const activeSessionId = useMemo(
    () =>
      visibleSessionIdForPane(
        activePane,
        backgroundTerminalIds[activePane],
        visibleSessionIds[activePane],
      ),
    [activePane, backgroundTerminalIds, visibleSessionIds],
  );
  const allSessionIds = useMemo(() => {
    const sessionIds = [...paneIds];
    for (const paneId of paneIds) {
      sessionIds.push(...(backgroundTerminalIds[paneId] ?? []));
    }
    return sessionIds;
  }, [backgroundTerminalIds, paneIds]);
  const renderableSessionIds = useMemo(() => {
    const ids = new Set<string>();
    for (const paneId of livePaneIds) {
      const paneBackgroundIds = backgroundTerminalIds[paneId];
      ids.add(visibleSessionIdForPane(paneId, paneBackgroundIds, visibleSessionIds[paneId]));
      if (paneId === activePane) {
        for (const id of paneSessionIds(paneId, paneBackgroundIds)) {
          ids.add(id);
        }
      }
    }
    return [...ids];
  }, [activePane, backgroundTerminalIds, livePaneIds, visibleSessionIds]);
  const livePaneIdSet = useMemo(() => new Set(livePaneIds), [livePaneIds]);
  const renderableSessionIdSet = useMemo(() => new Set(renderableSessionIds), [renderableSessionIds]);
  renderableSessionIdsRef.current = renderableSessionIds;
  activeSessionIdRef.current = activeSessionId;

  const centerNode = useCallback((container: HTMLElement | null, node: HTMLElement | null, behavior: ScrollBehavior) => {
    if (!container || !node) return;
    const idealLeft = node.offsetLeft - (container.clientWidth - node.clientWidth) / 2;
    const maxScroll = Math.max(0, container.scrollWidth - container.clientWidth);
    const nextLeft = Math.max(0, Math.min(maxScroll, idealLeft));

    if (centerScrollAnimationRef.current != null) {
      window.cancelAnimationFrame(centerScrollAnimationRef.current);
      centerScrollAnimationRef.current = null;
    }

    if (behavior !== "smooth") {
      container.scrollTo({ left: nextLeft, behavior: "auto" });
      return;
    }

    const startLeft = container.scrollLeft;
    const distance = nextLeft - startLeft;
    if (Math.abs(distance) < 1) {
      container.scrollTo({ left: nextLeft, behavior: "auto" });
      return;
    }

    const startedAt = performance.now();
    const step = (now: number) => {
      const elapsed = now - startedAt;
      const progress = Math.min(1, elapsed / PANE_CENTER_ANIMATION_MS);
      const eased = 1 - Math.pow(1 - progress, 3);
      container.scrollLeft = startLeft + distance * eased;
      if (progress < 1) {
        centerScrollAnimationRef.current = window.requestAnimationFrame(step);
        return;
      }
      centerScrollAnimationRef.current = null;
    };

    centerScrollAnimationRef.current = window.requestAnimationFrame(step);
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
        next[id] = defaultPaneWidthRef.current;
      }
      for (const [id, width] of Object.entries(prev)) {
        if (ids.includes(id)) continue;
        next[id] = width;
      }
      return next;
    });
    setPaneAvatarIds(assignUniqueAvatars(ids));
    setBackgroundTerminalIds({});
    setVisibleSessionIds({});
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

  const hydrateExistingTerminals = useCallback(
    (sessionIds: string[]) => {
      const layout = recoverTerminalLayout(sessionIds);
      const ids = layout.paneIds;
      if (ids.length === 0) {
        ensureBootstrapTerminals();
        return;
      }

      const nextPaneOrdinal = ids.reduce((maxOrdinal, id) => {
        const match = /^term-(\d+)$/.exec(id);
        if (!match) return maxOrdinal;
        return Math.max(maxOrdinal, Number(match[1]) + 1);
      }, 1);
      nextPaneOrdinalRef.current = Math.max(nextPaneOrdinal, ids.length + 1);
      createdIdsRef.current = new Set(sessionIds);

      setPaneIds(ids);
      setPaneWidths((prev) => {
        const next: Record<string, number> = {};
        for (const id of ids) {
          next[id] = prev[id] ?? defaultPaneWidthRef.current;
        }
        return next;
      });
      setPaneAvatarIds((prev) => {
        return assignPaneAvatars(ids, AVATAR_IDS, prev);
      });
      setBackgroundTerminalIds(layout.backgroundTerminalIds);
      setVisibleSessionIds((prev) => {
        const next: Record<string, string> = {};
        for (const id of ids) {
          const validSessionIds = new Set(paneSessionIds(id, layout.backgroundTerminalIds[id]));
          const previousVisibleSessionId = prev[id];
          const recoveredVisibleSessionId = layout.visibleSessionIds[id];
          const visibleSessionId = previousVisibleSessionId && validSessionIds.has(previousVisibleSessionId)
            ? previousVisibleSessionId
            : recoveredVisibleSessionId && validSessionIds.has(recoveredVisibleSessionId)
              ? recoveredVisibleSessionId
              : undefined;
          if (visibleSessionId && visibleSessionId !== id) {
            next[id] = visibleSessionId;
          }
        }
        return next;
      });
      setPaneCwds((prev) => {
        const next: Record<string, string | undefined> = {};
        for (const id of sessionIds) {
          if (id in prev) next[id] = prev[id];
        }
        return next;
      });

      const sessionIdSet = new Set(sessionIds);
      framesRef.current = Object.fromEntries(
        Object.entries(framesRef.current).filter(([id]) => sessionIdSet.has(id)),
      );
      frameQueuesRef.current = Object.fromEntries(
        Object.entries(frameQueuesRef.current).filter(([id]) => sessionIdSet.has(id)),
      );
      avatarActivityRef.current = Object.fromEntries(
        Object.entries(avatarActivityRef.current).filter(([id]) => sessionIdSet.has(id)),
      );
      avatarStatesRef.current = Object.fromEntries(
        sessionIds.map((id) => [id, avatarStatesRef.current[id] ?? ("idle" as const)]),
      );
      paneStatusRef.current = Object.fromEntries(sessionIds.map((id) => [id, "running" as const]));

      paneRuntimeStore.replaceAll(
        Object.fromEntries(
          sessionIds.map((id) => [
            id,
            {
              frame: framesRef.current[id],
              queuedFrames: frameQueuesRef.current[id] ?? [],
              avatarState: avatarStatesRef.current[id] ?? "idle",
              status: "running" as const,
            },
          ]),
        ),
      );

      const nextActivePane = ids.includes(activePaneRef.current) ? activePaneRef.current : ids[0] ?? FIRST_ID;
      setActivePaneCentered(nextActivePane, "auto");
      sessionIds.forEach((id) => {
        rpc.send({ type: "snapshot", id });
      });
      setStatus("Connected");
    },
    [ensureBootstrapTerminals, setActivePaneCentered],
  );

  const restoreCurrentTerminals = useCallback(() => {
    const ids = paneIdsRef.current;
    if (ids.length === 0) {
      ensureBootstrapTerminals();
      return;
    }

    const sessionIds = [
      ...ids,
      ...ids.flatMap((paneId) => backgroundTerminalIdsRef.current[paneId] ?? []),
    ];

    createdIdsRef.current.clear();
    paneStatusRef.current = Object.fromEntries(sessionIds.map((id) => [id, "booting" as const]));
    paneRuntimeStore.patchMany(
      Object.fromEntries(
        sessionIds.map((id) => [
          id,
          {
            status: "booting" as const,
            avatarState: avatarStatesRef.current[id] ?? "idle",
          },
        ]),
      ),
    );

    ids.forEach((id) => {
      const cwd = paneCwdsRef.current[id] ?? framesRef.current[id]?.cwd;
      createTerminal(id, cwd ? { cwd } : undefined);
    });
    ids.forEach((paneId) => {
      for (const backgroundId of backgroundTerminalIdsRef.current[paneId] ?? []) {
        const cwd =
          paneCwdsRef.current[backgroundId] ??
          paneCwdsRef.current[paneId] ??
          framesRef.current[backgroundId]?.cwd ??
          framesRef.current[paneId]?.cwd;
        createTerminal(backgroundId, cwd ? { cwd } : undefined);
      }
    });
    setStatus("Restoring terminals...");
  }, [createTerminal, ensureBootstrapTerminals]);

  const reconcileTerminals = useCallback(() => {
    if (!hasLaunchConfigRef.current || !hasDashboardConfigRef.current || !hasTerminalListRef.current) return;
    const serverIds = serverTerminalIdsRef.current;
    if (!bootstrappedRef.current) {
      bootstrappedRef.current = true;
      if (serverIds.length > 0) {
        hydrateExistingTerminals(serverIds);
        return;
      }
      ensureBootstrapTerminals();
      return;
    }
    if (serverIds.length > 0) {
      hydrateExistingTerminals(serverIds);
      return;
    }
    restoreCurrentTerminals();
  }, [ensureBootstrapTerminals, hydrateExistingTerminals, restoreCurrentTerminals]);

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
      const avatarId = pickAvailableAvatar(id, used);
      if (!avatarId) return prev;
      return { ...prev, [id]: avatarId };
    });
    avatarStatesRef.current = { ...avatarStatesRef.current, [id]: "idle" };
    paneRuntimeStore.patchPane(id, { status: "booting", avatarState: "idle", queuedFrames: [] });
    setActivePaneCentered(id);
    const cwd = resolveNewPaneCwd(activeSessionIdRef.current, paneCwds, framesRef.current);
    createTerminal(id, cwd ? { cwd } : undefined);
  }, [createTerminal, defaultPaneWidth, paneCwds, setActivePaneCentered]);

  const triggerPaneStackFlip = useCallback((paneId: string) => {
    setPaneStackFlipNonce((prev) => ({
      ...prev,
      [paneId]: (prev[paneId] ?? 0) + 1,
    }));
  }, []);

  const createBackgroundTerminalForPane = useCallback(
    (paneId: string, { show = true }: { show?: boolean } = {}) => {
      const existingBackgroundIds = backgroundTerminalIdsRef.current[paneId] ?? [];
      const backgroundId = backgroundTerminalIdForPane(paneId, nextBackgroundTerminalOrdinal(existingBackgroundIds));
      paneStatusRef.current = { ...paneStatusRef.current, [backgroundId]: "booting" };
      avatarStatesRef.current = { ...avatarStatesRef.current, [backgroundId]: "idle" };
      paneRuntimeStore.patchPane(backgroundId, { status: "booting", avatarState: "idle", queuedFrames: [] });
      setBackgroundTerminalIds((prev) => ({
        ...prev,
        [paneId]: sortBackgroundTerminalIds([...(prev[paneId] ?? []), backgroundId]),
      }));
      if (show) {
        setVisibleSessionIds((prev) => ({ ...prev, [paneId]: backgroundId }));
      }

      const launch: PaneLaunchConfig = {};
      const sourceSessionId = visibleSessionIdForPane(
        paneId,
        existingBackgroundIds,
        visibleSessionIdsRef.current[paneId],
      );
      const cwd =
        paneCwds[sourceSessionId] ??
        framesRef.current[sourceSessionId]?.cwd ??
        paneCwds[paneId] ??
        framesRef.current[paneId]?.cwd;
      if (cwd) {
        launch.cwd = cwd;
      }
      createTerminal(backgroundId, launch);
      return backgroundId;
    },
    [createTerminal, paneCwds],
  );

  const cyclePaneTerminalForPane = useCallback(
    (paneId: string) => {
      if (!paneId) return;
      const paneIndex = paneIdsRef.current.indexOf(paneId);
      const paneLabel = paneTitle(paneIndex >= 0 ? paneIndex : 0);

      const backgroundIds = backgroundTerminalIdsRef.current[paneId] ?? [];
      if (backgroundIds.length === 0) {
        createBackgroundTerminalForPane(paneId);
        triggerPaneStackFlip(paneId);
        setActivePaneCentered(paneId);
        setStatus(`${paneLabel} background terminal ready`);
        return;
      }

      const sessionIds = paneSessionIds(paneId, backgroundIds);
      const currentSessionId = visibleSessionIdForPane(paneId, backgroundIds, visibleSessionIdsRef.current[paneId]);
      const currentIndex = Math.max(0, sessionIds.indexOf(currentSessionId));
      const nextSessionId = sessionIds[(currentIndex + 1) % sessionIds.length] ?? paneId;
      setVisibleSessionIds((prev) => {
        if (nextSessionId === paneId) {
          const next = { ...prev };
          delete next[paneId];
          return next;
        }
        return { ...prev, [paneId]: nextSessionId };
      });
      triggerPaneStackFlip(paneId);
      setActivePaneCentered(paneId);
      setStatus(
        `${paneLabel} ${nextSessionId === paneId ? "main terminal restored" : "background terminal opened"}`,
      );
    },
    [createBackgroundTerminalForPane, setActivePaneCentered, triggerPaneStackFlip],
  );

  const addBackgroundTerminalForPane = useCallback(
    (paneId: string) => {
      if (!paneId) return;
      const paneIndex = paneIdsRef.current.indexOf(paneId);
      const paneLabel = paneTitle(paneIndex >= 0 ? paneIndex : 0);
      const backgroundId = createBackgroundTerminalForPane(paneId);
      const backgroundCount = (backgroundTerminalIdsRef.current[paneId]?.length ?? 0) + 1;
      triggerPaneStackFlip(paneId);
      setActivePaneCentered(paneId);
      setStatus(`${paneLabel} background terminal ${backgroundCount} opened (${backgroundId})`);
    },
    [createBackgroundTerminalForPane, setActivePaneCentered, triggerPaneStackFlip],
  );

  const toggleBackgroundTerminal = useCallback(() => {
    const paneId = activePaneRef.current;
    if (!paneId) return;
    cyclePaneTerminalForPane(paneId);
  }, [cyclePaneTerminalForPane]);

  const addBackgroundTerminal = useCallback(() => {
    const paneId = activePaneRef.current;
    if (!paneId) return;
    addBackgroundTerminalForPane(paneId);
  }, [addBackgroundTerminalForPane]);

  const bringRearTerminalToFront = useCallback(
    (paneId: string) => {
      cyclePaneTerminalForPane(paneId);
    },
    [cyclePaneTerminalForPane],
  );

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
    const paneId = activePaneRef.current;
    if (!paneId) return;
    for (const backgroundId of backgroundTerminalIdsRef.current[paneId] ?? []) {
      rpc.send({ type: "kill", id: backgroundId });
    }
    rpc.send({ type: "kill", id: paneId });
    setStatus(`Closing ${paneId}...`);
  }, []);

  const saveDashboardConfig = useCallback((nextConfig: DashboardConfig) => {
    setDashboardConfig(nextConfig);
    rpc.send({ type: "set-config", config: nextConfig });
    setStatus("Settings saved");
  }, []);

  const handlePaneShortcut = useCallback(
    (
      shortcut:
        | "new-pane"
        | "toggle-background"
        | "new-background"
        | "focus-left"
        | "focus-right"
        | "move-left"
        | "move-right"
        | "close-pane"
        | "open-settings",
    ) => {
      if (shortcut === "new-pane") {
        addTerminalPane();
        return;
      }
      if (shortcut === "toggle-background") {
        toggleBackgroundTerminal();
        return;
      }
      if (shortcut === "new-background") {
        addBackgroundTerminal();
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
    [
      addBackgroundTerminal,
      addTerminalPane,
      closeActivePane,
      moveActivePane,
      openSettings,
      reorderActivePane,
      toggleBackgroundTerminal,
    ],
  );

  const handlePaneUserInput = useCallback((id: string) => {
    if (id !== activeSessionIdRef.current) return;
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

  const handlePaneTextPasteRegister = useCallback((id: string, handler: ((text: string) => void) | null) => {
    if (handler) {
      paneTextPasteHandlersRef.current[id] = handler;
      return;
    }
    delete paneTextPasteHandlersRef.current[id];
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
      const rawActivityFrame = update.activityFrame;
      const previousCwd = paneCwds[id] ?? framesRef.current[id]?.cwd;
      const effectiveCwd = resolvePaneCwdFromFrame(rawActivityFrame, previousCwd);
      const activityFrame = effectiveCwd === rawActivityFrame.cwd ? rawActivityFrame : { ...rawActivityFrame, cwd: effectiveCwd };
      const previousActivity = avatarActivityRef.current[id];
      nextFrames[id] = activityFrame;
      if (update.renderFrames.length > 0 && renderableSessionIdsRef.current.includes(id)) {
        nextFrameQueues[id] = update.renderFrames;
      } else {
        delete nextFrameQueues[id];
      }
      nextAvatarStates[id] = resolveAvatarDisplayState(activityFrame, previousActivity, nowMs);
      avatarActivityRef.current[id] = nextAvatarActivityState(activityFrame, previousActivity, nowMs);
      if (nextPaneStatus[id] !== "running") {
        nextPaneStatus[id] = "running";
      }
      runtimeUpdates[id] = {
        frame: activityFrame,
        queuedFrames: nextFrameQueues[id] ?? [],
        avatarState: nextAvatarStates[id],
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
    const disposeConnection = rpc.onConnectionChange((connected) => {
      if (connected) return;
      hasTerminalListRef.current = false;
      serverTerminalIdsRef.current = [];
      setStatus(bootstrappedRef.current ? "Reconnecting..." : "Connecting...");
    });
    const disposeReady = rpc.onReady(() => {
      setStatus("Connected");
      hasTerminalListRef.current = false;
      rpc.send({ type: "launch-config" });
      rpc.send({ type: "get-config" });
      rpc.send({ type: "list" });
    });
    const disposeConfig = rpc.onConfig((config) => {
      defaultPaneWidthRef.current = config.defaultPaneWidth;
      hasDashboardConfigRef.current = true;
      setDashboardConfig(config);
      reconcileTerminals();
    });
    const disposeLaunchConfig = rpc.onLaunchConfig((config) => {
      launchConfigRef.current = config;
      hasLaunchConfigRef.current = true;
      reconcileTerminals();
    });
    const disposeTerminalList = rpc.onTerminalList((ids) => {
      serverTerminalIdsRef.current = ids;
      hasTerminalListRef.current = true;
      reconcileTerminals();
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
      const shouldQueueRenderFrames = renderableSessionIdsRef.current.includes(frame.id);
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
      createdIdsRef.current.delete(id);
      const owningPaneId =
        paneIdsRef.current.includes(id)
          ? id
          : Object.entries(backgroundTerminalIdsRef.current).find(([, backgroundIds]) => backgroundIds.includes(id))?.[0];

      if (owningPaneId && backgroundTerminalIdsRef.current[owningPaneId]?.includes(id)) {
        setStatus(`${id} exited (${code})`);
        delete pendingFrameUpdatesRef.current[id];
        delete avatarActivityRef.current[id];
        delete framesRef.current[id];
        delete frameQueuesRef.current[id];
        delete avatarStatesRef.current[id];
        delete paneStatusRef.current[id];
        setBackgroundTerminalIds((prev) => {
          const nextBackgroundIds = (prev[owningPaneId] ?? []).filter((backgroundId) => backgroundId !== id);
          const next = { ...prev };
          if (nextBackgroundIds.length > 0) {
            next[owningPaneId] = nextBackgroundIds;
          } else {
            delete next[owningPaneId];
          }
          return next;
        });
        setVisibleSessionIds((prev) => {
          const next = { ...prev };
          if (next[owningPaneId] === id) {
            const remainingBackgroundIds = (backgroundTerminalIdsRef.current[owningPaneId] ?? []).filter(
              (backgroundId) => backgroundId !== id,
            );
            if (createdIdsRef.current.has(owningPaneId)) {
              delete next[owningPaneId];
            } else if (remainingBackgroundIds[0]) {
              next[owningPaneId] = remainingBackgroundIds[0];
            } else {
              delete next[owningPaneId];
            }
          }
          return next;
        });
        setPaneCwds((prev) => {
          const next = { ...prev };
          delete next[id];
          return next;
        });
        paneRuntimeStore.removePane(id);
        return;
      }

      setStatus(`${id} exited (${code})`);
      delete pendingFrameUpdatesRef.current[id];
      delete avatarActivityRef.current[id];
      delete framesRef.current[id];
      delete frameQueuesRef.current[id];
      delete avatarStatesRef.current[id];
      delete paneStatusRef.current[id];
      const backgroundIds = backgroundTerminalIdsRef.current[id] ?? [];
      if (backgroundIds.length > 0) {
        for (const backgroundId of backgroundIds) {
          delete pendingFrameUpdatesRef.current[backgroundId];
          delete avatarActivityRef.current[backgroundId];
          delete framesRef.current[backgroundId];
          delete frameQueuesRef.current[backgroundId];
          delete avatarStatesRef.current[backgroundId];
          delete paneStatusRef.current[backgroundId];
          rpc.send({ type: "kill", id: backgroundId });
        }
      }
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
      setBackgroundTerminalIds((prev) => {
        if (!(id in prev)) return prev;
        const next = { ...prev };
        delete next[id];
        return next;
      });
      setVisibleSessionIds((prev) => {
        if (!(id in prev)) return prev;
        const next = { ...prev };
        delete next[id];
        return next;
      });
      setPaneCwds((prev) => {
        const next = { ...prev };
        delete next[id];
        for (const backgroundId of backgroundIds) {
          delete next[backgroundId];
        }
        return next;
      });
      paneRuntimeStore.removePane(id);
      for (const backgroundId of backgroundIds) {
        paneRuntimeStore.removePane(backgroundId);
      }
    });

    rpc.send({ type: "launch-config" });
    rpc.send({ type: "get-config" });
    rpc.send({ type: "list" });

    return () => {
      if (pendingFrameFlushRafRef.current != null) {
        window.cancelAnimationFrame(pendingFrameFlushRafRef.current);
        pendingFrameFlushRafRef.current = null;
      }
      if (inputPriorityTimerRef.current != null) {
        window.clearTimeout(inputPriorityTimerRef.current);
        inputPriorityTimerRef.current = null;
      }
      disposeConnection();
      disposeReady();
      disposeConfig();
      disposeLaunchConfig();
      disposeTerminalList();
      disposeCreated();
      disposeFrame();
      disposeError();
      disposeExit();
    };
  }, [flushPendingFrames, reconcileTerminals, setActivePaneCentered]);

  useEffect(() => {
    const sessionIdSet = new Set(allSessionIds);
    for (const id of Object.keys(paneFlowPausedRef.current)) {
      if (!sessionIdSet.has(id)) delete paneFlowPausedRef.current[id];
    }

    for (const id of allSessionIds) {
      const paused = inputPriorityActive && id !== activeSessionId;
      if (paneFlowPausedRef.current[id] === paused) continue;
      paneFlowPausedRef.current[id] = paused;
      rpc.send({ type: "flow", id, paused });
    }
  }, [activeSessionId, allSessionIds, inputPriorityActive]);

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
      if (doesEventMatchShortcut(event, shortcuts.toggleBackgroundTerminal)) {
        event.preventDefault();
        toggleBackgroundTerminal();
        return;
      }
      if (doesEventMatchShortcut(event, shortcuts.addBackgroundTerminal)) {
        event.preventDefault();
        addBackgroundTerminal();
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
  }, [
    addBackgroundTerminal,
    addTerminalPane,
    closeActivePane,
    moveActivePane,
    openSettings,
    reorderActivePane,
    settingsOpen,
    shortcuts,
    toggleBackgroundTerminal,
  ]);

  useEffect(() => {
    const onPaste = (event: ClipboardEvent) => {
      if (event.defaultPrevented) return;
      if (settingsOpen) return;
      const imageFile = firstImageClipboardFile(event.clipboardData);
      if (imageFile) {
        if (isEditableEventTarget(event.target) && !isTerminalPasteTarget(event.target)) return;
        const id = activeSessionIdRef.current;
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
      const id = activeSessionIdRef.current;
      if (!id) return;
      event.preventDefault();
      dispatchTerminalTextPaste(
        text,
        paneTextPasteHandlersRef.current[id],
        (rawText) => {
          handlePaneUserInput(id);
          rpc.send({ type: "input", id, data: rawText, encoding: "utf8" });
        },
      );
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
        const frame = framesRef.current[id];
        const nextState = resolveAvatarDisplayState(frame, avatarActivityRef.current[id], nowMs);
        if (nextState === currentState) continue;
        nextAvatarStates[id] = nextState;
        runtimeUpdates[id] = { avatarState: nextState };
        changed = true;
      }

      for (const [id, frame] of Object.entries(framesRef.current)) {
        avatarActivityRef.current[id] = nextAvatarActivityState(frame, avatarActivityRef.current[id], nowMs);
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

  const paneWidthForId = useCallback(
    (id: string) => paneWidths[id] ?? defaultPaneWidth,
    [defaultPaneWidth, paneWidths],
  );

  useEffect(() => {
    const previousQueues = frameQueuesRef.current;
    let changed = false;
    const next: Record<string, TerminalFrame[]> = {};
    const runtimeUpdates: Record<string, PaneRuntimeState> = {};
    const renderableSessionSet = new Set(renderableSessionIds);
    for (const [id, queue] of Object.entries(previousQueues)) {
      if (renderableSessionSet.has(id)) {
        if (queue?.length) {
          next[id] = queue;
        }
        continue;
      }
      if (!queue?.length) continue;
      changed = true;
      runtimeUpdates[id] = { queuedFrames: [] };
    }
    for (const id of renderableSessionIds) {
      const queue = next[id] ?? [];
      runtimeUpdates[id] = { queuedFrames: queue };
    }
    if (changed || renderableSessionIds.some((id) => previousQueues[id] !== next[id])) {
      frameQueuesRef.current = next;
      paneRuntimeStore.patchMany(runtimeUpdates);
    } else if (Object.keys(runtimeUpdates).length > 0) {
      paneRuntimeStore.patchMany(runtimeUpdates);
    }

    for (const id of allSessionIds) {
      const isRenderable = renderableSessionSet.has(id);
      rpc.send({
        type: "frame-rate",
        id,
        intervalMs: id === activeSessionId ? 0 : isRenderable ? LIVE_VISIBLE_PANE_FRAME_INTERVAL_MS : backgroundFrameIntervalMs,
        previewOnly: !isRenderable,
      });
    }
    for (const id of renderableSessionIds) {
      rpc.send({ type: "snapshot", id });
    }
  }, [activeSessionId, allSessionIds, backgroundFrameIntervalMs, renderableSessionIds]);

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
      if (centerScrollAnimationRef.current != null) {
        window.cancelAnimationFrame(centerScrollAnimationRef.current);
        centerScrollAnimationRef.current = null;
      }
      document.body.classList.remove("pane-resize-active");
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [centerPaneWhenReady]);

  const rpcReady = status !== "Connecting..." && !status.startsWith("RPC error");
  const leadSpacerWidth = useMemo(() => {
    if (paneIds.length === 0) return 0;
    const firstId = paneIds[0];
    const firstWidth = paneWidthForId(firstId);
    return Math.max(0, Math.round(stripWidth / 2 - firstWidth / 2));
  }, [paneIds, paneWidthForId, stripWidth]);
  const trailSpacerWidth = useMemo(() => {
    if (paneIds.length === 0) return 0;
    const lastId = paneIds[paneIds.length - 1];
    const lastWidth = paneWidthForId(lastId);
    return Math.max(0, Math.round(stripWidth / 2 - lastWidth / 2));
  }, [paneIds, paneWidthForId, stripWidth]);
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
              <span className="shortcut-label">Cycle</span>
              <kbd>{shortcuts.toggleBackgroundTerminal}</kbd>
            </span>
            <span className="shortcut-pill">
              <span className="shortcut-label">New Background</span>
              <kbd>{shortcuts.addBackgroundTerminal}</kbd>
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
            className={`pane-slot ${(backgroundTerminalIds[id]?.length ?? 0) > 0 ? "pane-slot-has-background" : ""} ${
              visibleSessionIdForPane(id, backgroundTerminalIds[id], visibleSessionIds[id]) !== id
                ? "pane-slot-background-visible"
                : ""
            } ${
              paneStackFlipNonce[id]
                ? paneStackFlipNonce[id] % 2 === 0
                  ? "pane-slot-stack-flip-b"
                  : "pane-slot-stack-flip-a"
                : ""
            }`}
            ref={(node) => {
              paneSlotsRef.current[id] = node;
            }}
            style={{ width: `${paneWidthForId(id)}px` }}
          >
            {(() => {
              const backgroundIds = backgroundTerminalIds[id] ?? [];
              const backgroundCount = backgroundIds.length;
              const visibleSessionId = visibleSessionIdForPane(id, backgroundIds, visibleSessionIds[id]);
              const backgroundVisible = visibleSessionId !== id;
              const backgroundLayerSessionId = backgroundVisible ? visibleSessionId : (backgroundIds[0] ?? id);
              const visibleBackgroundIndex = backgroundVisible ? Math.max(0, backgroundIds.indexOf(visibleSessionId)) + 1 : 0;

              if (backgroundCount === 0) {
                return (
                  <>
                    <button
                      type="button"
                      className="pane-stack-badge pane-stack-badge-create"
                      onClick={() => cyclePaneTerminalForPane(id)}
                      aria-label={`Create background terminal for ${paneTitle(index)}`}
                      title={`Create background terminal (${shortcuts.toggleBackgroundTerminal})`}
                    >
                      <span>Create Background Terminal</span>
                      <kbd>{shortcuts.toggleBackgroundTerminal}</kbd>
                    </button>
                    <PaneSurfaceContainer
                      paneId={id}
                      sessionId={id}
                      index={index}
                      live={livePaneIdSet.has(id)}
                      active={activeSessionId === id}
                      accentStyle={paneAccentStyles[id]}
                      shortcuts={shortcuts}
                      onActivate={setActivePaneCentered}
                      onFramesQueued={handleFramesQueued}
                      onShortcut={handlePaneShortcut}
                      onUserInput={handlePaneUserInput}
                      onTextPasteRegister={handlePaneTextPasteRegister}
                    />
                  </>
                );
              }

              return (
                <div className="pane-stack-shell">
                  <div className="pane-stack-controls">
                    <button
                      type="button"
                      className="pane-stack-badge"
                      onClick={() => bringRearTerminalToFront(id)}
                      aria-label={`${backgroundVisible ? "Background terminal is in front" : "Main terminal is in front"} for ${paneTitle(index)}. Press to cycle.`}
                      title={`${backgroundVisible ? "Background terminal" : "Main terminal"} (${shortcuts.toggleBackgroundTerminal} to cycle)`}
                    >
                      <span>{backgroundVisible ? `Background ${visibleBackgroundIndex}` : "Main"}</span>
                      <kbd>{shortcuts.toggleBackgroundTerminal}</kbd>
                    </button>
                  </div>
                  <div className="pane-stack">
                    <div className="pane-stack-shadow pane-stack-shadow-rear" aria-hidden />
                    <div className="pane-stack-shadow pane-stack-shadow-front" aria-hidden />
                    <div className="pane-stack-layer pane-stack-layer-main" aria-hidden={backgroundVisible}>
                      <PaneSurfaceContainer
                        paneId={id}
                        sessionId={id}
                        index={index}
                        live={renderableSessionIdSet.has(id)}
                        active={activeSessionId === id}
                        accentStyle={paneAccentStyles[id]}
                        shortcuts={shortcuts}
                        onActivate={setActivePaneCentered}
                        onFramesQueued={handleFramesQueued}
                        onShortcut={handlePaneShortcut}
                        onUserInput={handlePaneUserInput}
                        onTextPasteRegister={handlePaneTextPasteRegister}
                      />
                    </div>
                    <div className="pane-stack-layer pane-stack-layer-background" aria-hidden={!backgroundVisible}>
                      <PaneSurfaceContainer
                        paneId={id}
                        sessionId={backgroundLayerSessionId}
                        index={index}
                        live={renderableSessionIdSet.has(backgroundLayerSessionId)}
                        active={activeSessionId === backgroundLayerSessionId}
                        accentStyle={paneAccentStyles[id]}
                        shortcuts={shortcuts}
                        onActivate={setActivePaneCentered}
                        onFramesQueued={handleFramesQueued}
                        onShortcut={handlePaneShortcut}
                        onUserInput={handlePaneUserInput}
                        onTextPasteRegister={handlePaneTextPasteRegister}
                      />
                    </div>
                  </div>
                </div>
              );
            })()}
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
                  startWidth: paneWidthForId(id),
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
