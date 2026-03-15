import { mkdirSync } from "node:fs";
import { join } from "node:path";

const outputDir = join(process.cwd(), ".electron");
mkdirSync(outputDir, { recursive: true });

const result = await Bun.build({
  entrypoints: [join(process.cwd(), "src/main/index.ts")],
  outdir: outputDir,
  target: "node",
  format: "cjs",
  external: ["electron", "ws"],
  sourcemap: "external",
  minify: false,
});

if (!result.success) {
  for (const log of result.logs) {
    console.error(log);
  }
  process.exit(1);
}
