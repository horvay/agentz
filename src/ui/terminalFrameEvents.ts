import type { TerminalFrame, TerminalId } from "../shared/protocol";

export interface TerminalRenderEvent {
  type: "render";
  id: TerminalId;
  frame: TerminalFrame;
}

export interface TerminalMetadataEvent {
  type: "metadata";
  id: TerminalId;
  frame: TerminalFrame;
}

export interface TerminalPreviewEvent {
  type: "preview";
  id: TerminalId;
  frame: TerminalFrame;
}

export interface TerminalImageEvent {
  type: "images";
  id: TerminalId;
  frame: TerminalFrame;
}

export interface SplitTerminalFrameEvents {
  render?: TerminalRenderEvent;
  metadata?: TerminalMetadataEvent;
  preview?: TerminalPreviewEvent;
  images?: TerminalImageEvent;
}

export function hasTerminalRenderPayload(frame: TerminalFrame) {
  return Boolean(
    frame.screenMode === "full" ||
      frame.renderVt ||
      frame.renderPatchVt ||
      frame.renderPatchBytes ||
      frame.imageDefinitions !== undefined ||
      frame.imageRemovedIds !== undefined ||
      frame.imagePlacements !== undefined,
  );
}

export function hasTerminalImagePayload(frame: TerminalFrame) {
  return frame.imageDefinitions !== undefined || frame.imageRemovedIds !== undefined || frame.imagePlacements !== undefined;
}

export function hasTerminalPreviewPayload(frame: TerminalFrame) {
  return frame.previewLines.length > 0 || frame.chunk.length > 0 || frame.vt.length > 0;
}

export function hasTerminalMetadataPayload(frame: TerminalFrame) {
  return Boolean(
    frame.cwd !== undefined ||
      frame.frameCause === "metadata" ||
      frame.shellBusy !== undefined ||
      frame.shellBusyAtMs !== undefined ||
      frame.altScreen !== undefined ||
      frame.cursorVisible !== undefined ||
      frame.cursorStyle !== undefined ||
      frame.cursorBlink !== undefined ||
      frame.cursorRow !== undefined ||
      frame.cursorCol !== undefined ||
      frame.mouseTrackingMode !== undefined ||
      frame.mouseFormat !== undefined ||
      frame.focusEvent !== undefined ||
      frame.mouseAlternateScroll !== undefined ||
      frame.bracketedPasteMode !== undefined,
  );
}

export function splitTerminalFrameEvents(frame: TerminalFrame): SplitTerminalFrameEvents {
  return {
    render: hasTerminalRenderPayload(frame) ? { type: "render", id: frame.id, frame } : undefined,
    metadata: hasTerminalMetadataPayload(frame) ? { type: "metadata", id: frame.id, frame } : undefined,
    preview: hasTerminalPreviewPayload(frame) ? { type: "preview", id: frame.id, frame } : undefined,
    images: hasTerminalImagePayload(frame) ? { type: "images", id: frame.id, frame } : undefined,
  };
}
