import type { DashboardConfig } from "./config";

export type TerminalId = string;

export interface TerminalScreenRow {
  index: number;
  text: string;
}

export interface PaneLaunchConfig {
  command?: string;
  args?: string[];
  cwd?: string;
}

export interface LaunchConfig {
  panes?: PaneLaunchConfig[];
}

export interface TerminalFrame {
  id: TerminalId;
  cols: number;
  rows: number;
  seq: number;
  cwd?: string;
  screenMode?: "full" | "patch";
  screenRows?: TerminalScreenRow[];
  // Canonical full-frame VT snapshot from libghostty-vt (if available).
  renderVt?: string;
  // Incremental VT patch from libghostty-vt for changed rows/cursor state.
  renderPatchVt?: string;
  // Binary VT patch for direct xterm writes when the host has raw PTY bytes.
  renderPatchBytes?: Uint8Array;
  renderPatchKind?: "cursor-only" | "row-update" | "alt-row-update";
  // Whether Ghostty VT is currently on alternate screen buffer.
  altScreen?: boolean;
  chunk: string;
  // Raw VT stream captured for now; renderer interprets incrementally.
  vt: string;
  previewLines: string[];
  cursorVisible?: boolean;
  cursorStyle?: "block" | "underline" | "bar";
  cursorBlink?: boolean;
  cursorRow?: number;
  cursorCol?: number;
  mouseTrackingMode?: "none" | "x10" | "normal" | "button" | "any";
  mouseFormat?: "x10" | "utf8" | "sgr" | "urxvt" | "sgr-pixels";
  focusEvent?: boolean;
  mouseAlternateScroll?: boolean;
  // True when the interactive shell in this PTY currently has a live child process.
  shellBusy?: boolean;
  // Timestamp from the native host when shellBusy last changed.
  shellBusyAtMs?: number;
}

const WS_BINARY_PACKET_TERMINAL_FRAME = 1;
const OPTIONAL_STRING_LENGTH_SENTINEL = 0xffffffff;
const OPTIONAL_U16_SENTINEL = 0xffff;

const OPTIONAL_BOOLEAN_FIELDS = [
  "altScreen",
  "cursorVisible",
  "cursorBlink",
  "focusEvent",
  "mouseAlternateScroll",
  "shellBusy",
] as const satisfies ReadonlyArray<keyof TerminalFrame>;

type OptionalBooleanField = (typeof OPTIONAL_BOOLEAN_FIELDS)[number];

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

function encodeCursorStyle(value: TerminalFrame["cursorStyle"]): number {
  if (value === undefined) return 255;
  if (value === "block") return 0;
  if (value === "underline") return 1;
  return 2;
}

function decodeCursorStyle(value: number): TerminalFrame["cursorStyle"] {
  if (value === 0) return "block";
  if (value === 1) return "underline";
  if (value === 2) return "bar";
  return undefined;
}

function encodePatchKind(value: TerminalFrame["renderPatchKind"]): number {
  if (value === undefined) return 255;
  if (value === "cursor-only") return 0;
  if (value === "row-update") return 1;
  return 2;
}

function decodePatchKind(value: number): TerminalFrame["renderPatchKind"] {
  if (value === 0) return "cursor-only";
  if (value === 1) return "row-update";
  if (value === 2) return "alt-row-update";
  return undefined;
}

function encodeMouseTrackingMode(value: TerminalFrame["mouseTrackingMode"]): number {
  if (value === undefined) return 255;
  if (value === "none") return 0;
  if (value === "x10") return 1;
  if (value === "normal") return 2;
  if (value === "button") return 3;
  return 4;
}

function decodeMouseTrackingMode(value: number): TerminalFrame["mouseTrackingMode"] {
  if (value === 0) return "none";
  if (value === 1) return "x10";
  if (value === 2) return "normal";
  if (value === 3) return "button";
  if (value === 4) return "any";
  return undefined;
}

function encodeMouseFormat(value: TerminalFrame["mouseFormat"]): number {
  if (value === undefined) return 255;
  if (value === "x10") return 0;
  if (value === "utf8") return 1;
  if (value === "sgr") return 2;
  if (value === "urxvt") return 3;
  return 4;
}

function decodeMouseFormat(value: number): TerminalFrame["mouseFormat"] {
  if (value === 0) return "x10";
  if (value === 1) return "utf8";
  if (value === 2) return "sgr";
  if (value === 3) return "urxvt";
  if (value === 4) return "sgr-pixels";
  return undefined;
}

function encodeScreenMode(value: TerminalFrame["screenMode"]): number {
  if (value === undefined) return 255;
  return value === "full" ? 0 : 1;
}

function decodeScreenMode(value: number): TerminalFrame["screenMode"] {
  if (value === 0) return "full";
  if (value === 1) return "patch";
  return undefined;
}

function encodeRequiredString(value: string): Uint8Array {
  return textEncoder.encode(value);
}

function encodeOptionalString(value: string | undefined): Uint8Array | null {
  return value === undefined ? null : textEncoder.encode(value);
}

function writeRequiredString(view: DataView, target: Uint8Array, offset: number, bytes: Uint8Array): number {
  view.setUint32(offset, bytes.byteLength, true);
  offset += 4;
  target.set(bytes, offset);
  return offset + bytes.byteLength;
}

function writeOptionalString(
  view: DataView,
  target: Uint8Array,
  offset: number,
  bytes: Uint8Array | null,
): number {
  if (bytes === null) {
    view.setUint32(offset, OPTIONAL_STRING_LENGTH_SENTINEL, true);
    return offset + 4;
  }
  return writeRequiredString(view, target, offset, bytes);
}

function readRequiredString(view: DataView, source: Uint8Array, offset: number): [string, number] {
  const length = view.getUint32(offset, true);
  offset += 4;
  const nextOffset = offset + length;
  return [textDecoder.decode(source.subarray(offset, nextOffset)), nextOffset];
}

function writeOptionalBytes(
  view: DataView,
  target: Uint8Array,
  offset: number,
  bytes: Uint8Array | null,
): number {
  if (bytes === null) {
    view.setUint32(offset, OPTIONAL_STRING_LENGTH_SENTINEL, true);
    return offset + 4;
  }
  view.setUint32(offset, bytes.byteLength, true);
  offset += 4;
  target.set(bytes, offset);
  return offset + bytes.byteLength;
}

function readOptionalBytes(view: DataView, source: Uint8Array, offset: number): [Uint8Array | undefined, number] {
  const length = view.getUint32(offset, true);
  offset += 4;
  if (length === OPTIONAL_STRING_LENGTH_SENTINEL) {
    return [undefined, offset];
  }
  const nextOffset = offset + length;
  return [source.slice(offset, nextOffset), nextOffset];
}

function readOptionalString(view: DataView, source: Uint8Array, offset: number): [string | undefined, number] {
  const length = view.getUint32(offset, true);
  offset += 4;
  if (length === OPTIONAL_STRING_LENGTH_SENTINEL) {
    return [undefined, offset];
  }
  const nextOffset = offset + length;
  return [textDecoder.decode(source.subarray(offset, nextOffset)), nextOffset];
}

function toUint8Array(packet: ArrayBuffer | Uint8Array): Uint8Array {
  return packet instanceof Uint8Array ? packet : new Uint8Array(packet);
}

export function encodeTerminalFramePacket(frame: TerminalFrame): Uint8Array {
  const id = encodeRequiredString(frame.id);
  const cwd = encodeOptionalString(frame.cwd);
  const screenRows = frame.screenRows ?? [];
  const encodedScreenRows = screenRows.map((row) => ({
    index: row.index,
    textBytes: encodeRequiredString(row.text),
  }));
  const renderVt = encodeOptionalString(frame.renderVt);
  const renderPatchVt = encodeOptionalString(frame.renderPatchVt);
  const renderPatchBytes = frame.renderPatchBytes ?? null;
  const chunk = encodeRequiredString(frame.chunk);
  const vt = encodeRequiredString(frame.vt);
  const previewLines = frame.previewLines.map(encodeRequiredString);

  const boolFlags = OPTIONAL_BOOLEAN_FIELDS.reduce(
    (acc, field, index) => {
      const value = frame[field] as boolean | undefined;
      if (value === undefined) return acc;
      const bit = 1 << index;
      return {
        presence: acc.presence | bit,
        values: acc.values | (value ? bit : 0),
      };
    },
    { presence: 0, values: 0 },
  );

  const fixedBytes = 1 + 2 + 2 + 4 + 1 + 1 + 1 + 1 + 1 + 1 + 2 + 2 + 8 + 4 * 7 + 2 + 1 + 2;
  const previewBytes = previewLines.reduce((sum, line) => sum + 4 + line.byteLength, 0);
  const screenRowBytes = encodedScreenRows.reduce(
    (sum, row) => sum + 2 + 4 + row.textBytes.byteLength,
    0,
  );
  const totalBytes =
    fixedBytes +
    id.byteLength +
    (cwd?.byteLength ?? 0) +
    (renderVt?.byteLength ?? 0) +
    (renderPatchVt?.byteLength ?? 0) +
    (renderPatchBytes?.byteLength ?? 0) +
    chunk.byteLength +
    vt.byteLength +
    previewBytes +
    screenRowBytes;

  const packet = new Uint8Array(totalBytes);
  const view = new DataView(packet.buffer, packet.byteOffset, packet.byteLength);
  let offset = 0;

  packet[offset++] = WS_BINARY_PACKET_TERMINAL_FRAME;
  view.setUint16(offset, frame.cols, true);
  offset += 2;
  view.setUint16(offset, frame.rows, true);
  offset += 2;
  view.setUint32(offset, frame.seq, true);
  offset += 4;
  packet[offset++] = boolFlags.presence;
  packet[offset++] = boolFlags.values;
  packet[offset++] = encodeCursorStyle(frame.cursorStyle);
  packet[offset++] = encodePatchKind(frame.renderPatchKind);
  packet[offset++] = encodeMouseTrackingMode(frame.mouseTrackingMode);
  packet[offset++] = encodeMouseFormat(frame.mouseFormat);
  view.setUint16(offset, frame.cursorRow ?? OPTIONAL_U16_SENTINEL, true);
  offset += 2;
  view.setUint16(offset, frame.cursorCol ?? OPTIONAL_U16_SENTINEL, true);
  offset += 2;
  view.setFloat64(offset, frame.shellBusyAtMs ?? Number.NaN, true);
  offset += 8;
  offset = writeRequiredString(view, packet, offset, id);
  offset = writeOptionalString(view, packet, offset, cwd);
  offset = writeOptionalString(view, packet, offset, renderVt);
  offset = writeOptionalString(view, packet, offset, renderPatchVt);
  offset = writeOptionalBytes(view, packet, offset, renderPatchBytes);
  offset = writeRequiredString(view, packet, offset, chunk);
  offset = writeRequiredString(view, packet, offset, vt);
  view.setUint16(offset, previewLines.length, true);
  offset += 2;
  for (const line of previewLines) {
    offset = writeRequiredString(view, packet, offset, line);
  }
  packet[offset++] = encodeScreenMode(frame.screenMode);
  view.setUint16(offset, encodedScreenRows.length, true);
  offset += 2;
  for (const row of encodedScreenRows) {
    view.setUint16(offset, row.index, true);
    offset += 2;
    offset = writeRequiredString(view, packet, offset, row.textBytes);
  }

  return packet;
}

export function decodeTerminalFramePacket(packet: ArrayBuffer | Uint8Array): TerminalFrame {
  const bytes = toUint8Array(packet);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 0;

  const packetKind = bytes[offset++];
  if (packetKind !== WS_BINARY_PACKET_TERMINAL_FRAME) {
    throw new Error(`Unsupported terminal frame packet kind: ${packetKind}`);
  }

  const cols = view.getUint16(offset, true);
  offset += 2;
  const rows = view.getUint16(offset, true);
  offset += 2;
  const seq = view.getUint32(offset, true);
  offset += 4;
  const boolPresence = bytes[offset++];
  const boolValues = bytes[offset++];
  const cursorStyle = decodeCursorStyle(bytes[offset++]);
  const renderPatchKind = decodePatchKind(bytes[offset++]);
  const mouseTrackingMode = decodeMouseTrackingMode(bytes[offset++]);
  const mouseFormat = decodeMouseFormat(bytes[offset++]);
  const rawCursorRow = view.getUint16(offset, true);
  offset += 2;
  const rawCursorCol = view.getUint16(offset, true);
  offset += 2;
  const rawShellBusyAtMs = view.getFloat64(offset, true);
  offset += 8;

  const [id, afterId] = readRequiredString(view, bytes, offset);
  offset = afterId;
  const [cwd, afterCwd] = readOptionalString(view, bytes, offset);
  offset = afterCwd;
  const [renderVt, afterRenderVt] = readOptionalString(view, bytes, offset);
  offset = afterRenderVt;
  const [renderPatchVt, afterRenderPatchVt] = readOptionalString(view, bytes, offset);
  offset = afterRenderPatchVt;
  const [renderPatchBytes, afterRenderPatchBytes] = readOptionalBytes(view, bytes, offset);
  offset = afterRenderPatchBytes;
  const [chunk, afterChunk] = readRequiredString(view, bytes, offset);
  offset = afterChunk;
  const [vt, afterVt] = readRequiredString(view, bytes, offset);
  offset = afterVt;
  const previewCount = view.getUint16(offset, true);
  offset += 2;
  const previewLines: string[] = [];
  for (let index = 0; index < previewCount; index += 1) {
    const [line, nextOffset] = readRequiredString(view, bytes, offset);
    previewLines.push(line);
    offset = nextOffset;
  }
  const screenMode = decodeScreenMode(bytes[offset++] ?? 255);
  const screenRowCount = view.getUint16(offset, true);
  offset += 2;
  const screenRows: TerminalScreenRow[] = [];
  for (let index = 0; index < screenRowCount; index += 1) {
    const rowIndex = view.getUint16(offset, true);
    offset += 2;
    const [text, nextOffset] = readRequiredString(view, bytes, offset);
    screenRows.push({ index: rowIndex, text });
    offset = nextOffset;
  }

  const frame: TerminalFrame = {
    id,
    cols,
    rows,
    seq,
    cwd,
    screenMode,
    screenRows: screenRows.length > 0 ? screenRows : undefined,
    renderVt,
    renderPatchVt,
    renderPatchBytes,
    renderPatchKind,
    chunk,
    vt,
    previewLines,
    cursorStyle,
    cursorRow: rawCursorRow === OPTIONAL_U16_SENTINEL ? undefined : rawCursorRow,
    cursorCol: rawCursorCol === OPTIONAL_U16_SENTINEL ? undefined : rawCursorCol,
    mouseTrackingMode,
    mouseFormat,
    shellBusyAtMs: Number.isNaN(rawShellBusyAtMs) ? undefined : rawShellBusyAtMs,
  };

  OPTIONAL_BOOLEAN_FIELDS.forEach((field, index) => {
    const bit = 1 << index;
    if ((boolPresence & bit) === 0) return;
    (frame as Record<OptionalBooleanField, boolean | undefined>)[field] = (boolValues & bit) !== 0;
  });

  return frame;
}

export type ClientMessage =
  | {
      type: "create";
      id: TerminalId;
      cols: number;
      rows: number;
      cwd?: string;
      command?: string;
      args?: string[];
    }
  | {
      type: "resize";
      id: TerminalId;
      cols: number;
      rows: number;
    }
  | {
      type: "input";
      id: TerminalId;
      data: string;
      encoding?: "utf8" | "binary";
    }
  | {
      type: "paste-image";
      id: TerminalId;
      dataBase64: string;
      mimeType: string;
      fileName?: string;
    }
  | {
      type: "flow";
      id: TerminalId;
      paused: boolean;
    }
  | {
      type: "frame-rate";
      id: TerminalId;
      intervalMs: number;
      previewOnly: boolean;
    }
  | {
      type: "snapshot";
      id: TerminalId;
    }
  | {
      type: "list";
    }
  | {
      type: "launch-config";
    }
  | {
      type: "get-config";
    }
  | {
      type: "set-config";
      config: DashboardConfig;
    }
  | {
      type: "kill";
      id: TerminalId;
    };

export type ServerMessage =
  | { type: "ready"; serverVersion: string }
  | { type: "config"; config: DashboardConfig }
  | { type: "terminal-created"; id: TerminalId }
  | { type: "terminal-exited"; id: TerminalId; exitCode: number }
  | { type: "terminal-frame"; frame: TerminalFrame }
  | { type: "terminal-list"; ids: TerminalId[] }
  | { type: "launch-config"; config: LaunchConfig }
  | { type: "error"; id?: TerminalId; message: string };

export type JsonServerMessage = Exclude<ServerMessage, { type: "terminal-frame" }>;
