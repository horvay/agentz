import { TerminalSession } from "../src/main/terminalSession";

const session = new TerminalSession(
  "smoke-opencode",
  120,
  40,
  "bash",
  ["-lc", "opencode"],
);

let matched = false;
let exiting = false;
let typedHi = false;
let sawPostInputFrame = false;
let hiSentAt = 0;
let seqAtHi = 0;
let finished = false;
const timeoutHandle = setTimeout(() => {
  if (finished) return;
  if (matched && typedHi && !sawPostInputFrame) {
    console.log("opencode-smoke: timeout waiting for output after typing 'hi'");
  } else if (!matched) {
    console.log("opencode-smoke: timeout waiting for TUI startup");
  } else {
    console.log("opencode-smoke: timeout during shutdown");
  }
  session.kill();
  process.exitCode = 1;
}, 12_000);

function maybeExit(): void {
  if (!matched || !typedHi || !sawPostInputFrame || exiting) return;
  exiting = true;
  console.log("opencode-smoke: observed output after typing 'hi'");
  // Ask the TUI to exit gracefully first.
  session.input("\u0003");
  setTimeout(() => session.kill(), 800);
}

session.onData((frame) => {
  const text = frame.previewLines.join("\n");
  const tuiIndicators =
    text.includes("Ask anything") ||
    text.includes("OpenCode") ||
    text.includes("opencode");
  const altScreenEntered = frame.vt.includes("\x1b[?1049h");
  const commandMissing = text.includes("command not found") || text.includes("not found");

  if (commandMissing) {
    console.log("opencode-smoke: opencode command not found");
    process.exitCode = 1;
    session.kill();
    return;
  }

  if (tuiIndicators || altScreenEntered) {
    if (!matched) {
      matched = true;
      console.log("opencode-smoke: observed TUI startup output");
      console.log(text.slice(-800));
    }
    if (!typedHi) {
      typedHi = true;
      hiSentAt = Date.now();
      seqAtHi = frame.seq;
      session.input("hi");
      console.log("opencode-smoke: sent input 'hi'");
    }
  }

  if (typedHi && !sawPostInputFrame && frame.seq > seqAtHi) {
    sawPostInputFrame = true;
  }
  maybeExit();
});

session.onExit((code) => {
  finished = true;
  clearTimeout(timeoutHandle);
  if (!matched) {
    console.log(`opencode-smoke: exited without matched output (code=${code})`);
    process.exitCode = 1;
    return;
  }
  if (!typedHi || !sawPostInputFrame) {
    console.log(
      `opencode-smoke: exited before input verification (typedHi=${typedHi}, sawPostInputFrame=${sawPostInputFrame}, hiAgeMs=${hiSentAt ? Date.now() - hiSentAt : 0})`,
    );
    process.exitCode = 1;
    return;
  }
  console.log(`opencode-smoke: done (code=${code})`);
});
