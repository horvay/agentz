import { TerminalSession } from "../src/main/terminalSession";

const command = process.platform === "win32" ? "opencode" : "bash";
const args = process.platform === "win32" ? [] : ["-lc", "opencode"];

const session = new TerminalSession(
  "smoke-opencode",
  120,
  40,
  command,
  args,
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
  setTimeout(() => session.kill(), 300);
}

session.onData((frame) => {
  const text = frame.previewLines.join("\n");
  const tuiIndicators =
    text.includes("Ask anything") ||
    text.includes("OpenCode") ||
    text.includes("opencode");
  const altScreenEntered = frame.vt.includes("\x1b[?1049h");
  const commandMissing =
    text.includes("command not found") ||
    text.includes("not found") ||
    text.includes("not recognized as an internal or external command");

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
      session.input("hi\r");
      console.log("opencode-smoke: sent input 'hi' and submitted");
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
  let finalCode = 0;
  if (!matched) {
    console.log(`opencode-smoke: exited without matched output (code=${code})`);
    finalCode = 1;
  } else if (!typedHi || !sawPostInputFrame) {
    console.log(
      `opencode-smoke: exited before input verification (typedHi=${typedHi}, sawPostInputFrame=${sawPostInputFrame}, hiAgeMs=${hiSentAt ? Date.now() - hiSentAt : 0})`,
    );
    finalCode = 1;
  } else {
    console.log(`opencode-smoke: done (code=${code})`);
  }
  setTimeout(() => process.exit(finalCode), 0);
});
