import type { TerminalImageDefinition, TerminalImagePlacement } from "../shared/protocol";

export interface TerminalImageCellSize {
  width: number;
  height: number;
}

export interface TerminalImageDrawRect {
  x: number;
  y: number;
  width: number;
  height: number;
  sourceX: number;
  sourceY: number;
  sourceWidth: number;
  sourceHeight: number;
}

function placementSourceSize(
  placement: TerminalImagePlacement,
  image: TerminalImageDefinition,
): { width: number; height: number } {
  const imageWidth = Math.max(1, image.width);
  const imageHeight = Math.max(1, image.height);
  const sourceX = Math.max(0, Math.min(placement.sourceX, imageWidth));
  const sourceY = Math.max(0, Math.min(placement.sourceY, imageHeight));
  const sourceWidth = Math.max(1, Math.min(imageWidth - sourceX, placement.sourceWidth || imageWidth));
  const sourceHeight = Math.max(1, Math.min(imageHeight - sourceY, placement.sourceHeight || imageHeight));
  return { width: sourceWidth, height: sourceHeight };
}

function placementPixelSize(
  placement: TerminalImagePlacement,
  image: TerminalImageDefinition,
  cell: TerminalImageCellSize,
): { width: number; height: number } {
  const source = placementSourceSize(placement, image);
  if (placement.pixelWidth && placement.pixelHeight) {
    return {
      width: placement.pixelWidth,
      height: placement.pixelHeight,
    };
  }
  if (placement.columns > 0 && placement.rows > 0) {
    return {
      width: cell.width * placement.columns,
      height: cell.height * placement.rows,
    };
  }
  if (placement.columns > 0) {
    const width = cell.width * placement.columns;
    return {
      width,
      height: Math.round(width * (source.height / source.width)),
    };
  }
  if (placement.rows > 0) {
    const height = cell.height * placement.rows;
    return {
      width: Math.round(height * (source.width / source.height)),
      height,
    };
  }
  return source;
}

export function drawRectForTerminalImagePlacement(
  placement: TerminalImagePlacement,
  image: TerminalImageDefinition,
  cell: TerminalImageCellSize,
  viewportY: number,
): TerminalImageDrawRect {
  const source = placementSourceSize(placement, image);
  const size = placementPixelSize(placement, image, cell);
  return {
    x: placement.screenX * cell.width + placement.cellOffsetX,
    y: (placement.screenY - viewportY) * cell.height + placement.cellOffsetY,
    width: size.width,
    height: size.height,
    sourceX: Math.max(0, Math.min(placement.sourceX, image.width)),
    sourceY: Math.max(0, Math.min(placement.sourceY, image.height)),
    sourceWidth: source.width,
    sourceHeight: source.height,
  };
}

const TERMINAL_IMAGE_BACKGROUND_Z_LIMIT = Math.trunc(-2147483648 / 2);

export function terminalImageLayerForZ(z: number): "back" | "front" {
  return z < TERMINAL_IMAGE_BACKGROUND_Z_LIMIT ? "back" : "front";
}
