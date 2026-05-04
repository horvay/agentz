import { describe, expect, test } from "bun:test";

import type { TerminalImageDefinition, TerminalImagePlacement } from "../shared/protocol";
import { drawRectForTerminalImagePlacement, terminalImageLayerForZ } from "./terminalImages";

function image(partial: Partial<TerminalImageDefinition> = {}): TerminalImageDefinition {
  return {
    id: 7,
    width: 400,
    height: 200,
    format: "rgba",
    data: new Uint8Array(400 * 200 * 4),
    ...partial,
  };
}

function placement(partial: Partial<TerminalImagePlacement> = {}): TerminalImagePlacement {
  return {
    imageId: 7,
    screenX: 3,
    screenY: 10,
    z: 0,
    cellOffsetX: 0,
    cellOffsetY: 0,
    sourceX: 0,
    sourceY: 0,
    sourceWidth: 0,
    sourceHeight: 0,
    columns: 0,
    rows: 0,
    ...partial,
  };
}

describe("terminal image placement layout", () => {
  test("uses the cropped source dimensions when rows and columns are omitted", () => {
    expect(
      drawRectForTerminalImagePlacement(
        placement({ sourceX: 10, sourceY: 5, sourceWidth: 120, sourceHeight: 90 }),
        image(),
        { width: 8, height: 16 },
        8,
      ),
    ).toEqual({
      x: 24,
      y: 32,
      width: 120,
      height: 90,
      sourceX: 10,
      sourceY: 5,
      sourceWidth: 120,
      sourceHeight: 90,
    });
  });

  test("scales height from columns while preserving aspect ratio", () => {
    expect(
      drawRectForTerminalImagePlacement(
        placement({ columns: 4 }),
        image({ width: 400, height: 200 }),
        { width: 10, height: 20 },
        10,
      ),
    ).toMatchObject({
      x: 30,
      y: 0,
      width: 40,
      height: 20,
    });
  });

  test("scales width from rows while preserving aspect ratio", () => {
    expect(
      drawRectForTerminalImagePlacement(
        placement({ rows: 3 }),
        image({ width: 150, height: 300 }),
        { width: 9, height: 18 },
        9,
      ),
    ).toMatchObject({
      x: 27,
      y: 18,
      width: 27,
      height: 54,
    });
  });

  test("uses explicit pixel dimensions when the host provides them", () => {
    expect(
      drawRectForTerminalImagePlacement(
        placement({ columns: 4, rows: 3, pixelWidth: 37, pixelHeight: 52 }),
        image({ width: 150, height: 300 }),
        { width: 9, height: 18 },
        9,
      ),
    ).toMatchObject({
      x: 27,
      y: 18,
      width: 37,
      height: 52,
    });
  });

  test("only sends very low z placements behind the terminal background", () => {
    expect(terminalImageLayerForZ(-1)).toBe("front");
    expect(terminalImageLayerForZ(-1073741825)).toBe("back");
    expect(terminalImageLayerForZ(0)).toBe("front");
    expect(terminalImageLayerForZ(12)).toBe("front");
  });
});
