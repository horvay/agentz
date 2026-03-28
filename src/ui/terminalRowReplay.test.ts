import { describe, expect, test } from "bun:test";
import { SerializeAddon } from "@xterm/addon-serialize";
import { Terminal } from "@xterm/headless";

async function renderHtml(writes: string[]): Promise<string> {
  const terminal = new Terminal({
    cols: 10,
    rows: 2,
    scrollback: 0,
    allowProposedApi: true,
  });
  const serializer = new SerializeAddon();
  terminal.loadAddon(serializer);

  for (const chunk of writes) {
    await new Promise<void>((resolve) => terminal.write(chunk, resolve));
  }

  return serializer.serializeAsHTML({ includeGlobalBackground: true });
}

describe("terminal row replay", () => {
  test("reuses stale attributes when a row redraw skips sgr reset", async () => {
    const html = await renderHtml([
      "\u001b[?1049h\u001b[H\u001b[31mHELLO",
      "\u001b[2;1H\u001b[2Kworld",
    ]);

    expect(html).toContain("<div><span></span><span style='color: #cc0000;'>world</span>");
  });

  test("keeps default styling when a row redraw resets sgr first", async () => {
    const html = await renderHtml([
      "\u001b[?1049h\u001b[H\u001b[31mHELLO",
      "\u001b[2;1H\u001b[0m\u001b[2Kworld",
    ]);

    expect(html).toContain("<div><span>world     </span></div>");
  });
});
