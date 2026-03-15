import { getDesktopLaunchEnv, resolveBunExecutable, runInherited } from "./runtime";

const bun = resolveBunExecutable();
const env = {
  ...getDesktopLaunchEnv(),
  ELECTRON_HMR: "1",
};

const waitCode = await runInherited([bun, "x", "wait-on", "tcp:127.0.0.1:5173", ".electron/index.js"], {
  env,
});
if (waitCode !== 0) {
  process.exit(waitCode);
}

const runCode = await runInherited([bun, "x", "electronmon", "."], { env });
process.exit(runCode);
