const patterns = [
  "agentz-dev",
  "agentz-canary",
  "agentz",
  "ghostty-dashboard-mvp-dev",
  "ghostty-dashboard-mvp-canary",
  "ghostty-dashboard-mvp",
  "electronmon",
  "\\.electron/index\\.js",
  "bun src/main/web.ts",
  "src/main/web.ts",
];

function getProtectedPidsPosix(): Set<number> {
  const out = Bun.spawnSync(["ps", "-eo", "pid=,ppid="], {
    stdout: "pipe",
    stderr: "ignore",
  }).stdout.toString();
  const parentByPid = new Map<number, number>();
  for (const line of out.split("\n")) {
    const [pidText, ppidText] = line.trim().split(/\s+/);
    const pid = Number(pidText);
    const ppid = Number(ppidText);
    if (Number.isFinite(pid) && Number.isFinite(ppid)) {
      parentByPid.set(pid, ppid);
    }
  }
  const protectedPids = new Set<number>();
  let cursor = process.pid;
  while (Number.isFinite(cursor) && cursor > 0 && !protectedPids.has(cursor)) {
    protectedPids.add(cursor);
    cursor = parentByPid.get(cursor) ?? 0;
  }
  return protectedPids;
}

function killMatchingPosixProcesses(): void {
  const protectedPids = getProtectedPidsPosix();
  for (const pattern of patterns) {
    const out = Bun.spawnSync(["pgrep", "-af", pattern], {
      stdout: "pipe",
      stderr: "ignore",
    }).stdout.toString();
    for (const line of out.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const [pidText] = trimmed.split(/\s+/, 1);
      const pid = Number(pidText);
      if (!Number.isFinite(pid) || protectedPids.has(pid)) continue;
      Bun.spawnSync(["kill", String(pid)], {
        stdout: "ignore",
        stderr: "ignore",
      });
    }
  }
}

function killMatchingWindowsProcesses(): void {
  type WindowsProcessInfo = {
    ProcessId?: number;
    ParentProcessId?: number;
    Name?: string;
    CommandLine?: string | null;
  };

  const queryJson = (script: string): unknown[] => {
    const proc = Bun.spawnSync(
      ["powershell", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
      {
        stdout: "pipe",
        stderr: "ignore",
      },
    );
    if (proc.exitCode !== 0) return [];
    const text = proc.stdout.toString().trim();
    if (!text) return [];
    try {
      const parsed = JSON.parse(text);
      return Array.isArray(parsed) ? parsed : [parsed];
    } catch {
      return [];
    }
  };

  const processes = queryJson(
    "Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId, Name, CommandLine | ConvertTo-Json -Depth 3 -Compress",
  ) as WindowsProcessInfo[];
  const parentByPid = new Map<number, number>();
  for (const proc of processes) {
    const pid = Number(proc.ProcessId);
    if (!Number.isFinite(pid) || pid <= 0) continue;
    const parentPid = Number(proc.ParentProcessId);
    parentByPid.set(pid, Number.isFinite(parentPid) ? parentPid : 0);
  }

  const portOwners = queryJson(
    "Get-NetTCPConnection -LocalPort 5173,4599 -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique | ConvertTo-Json -Compress",
  )
    .map((value) => Number(value))
    .filter((pid) => Number.isFinite(pid) && pid > 0);

  const matchesPattern = (haystack: string): boolean => {
    for (const pattern of patterns) {
      try {
        if (new RegExp(pattern, "i").test(haystack)) return true;
      } catch {
        if (haystack.toLowerCase().includes(pattern.toLowerCase())) return true;
      }
    }
    return false;
  };

  const repoRoot = process.cwd().toLowerCase();
  const targets = new Set<number>();
  const addChain = (startPid: number) => {
    let cursor = startPid;
    while (Number.isFinite(cursor) && cursor > 0 && cursor !== process.pid && !targets.has(cursor)) {
      targets.add(cursor);
      cursor = parentByPid.get(cursor) ?? 0;
    }
  };

  for (const proc of processes) {
    const pid = Number(proc.ProcessId);
    if (!Number.isFinite(pid) || pid <= 0 || pid === process.pid) continue;
    const name = String(proc.Name ?? "");
    const commandLine = String(proc.CommandLine ?? "");
    const haystack = `${name} ${commandLine}`;
    const isRepoLocalRuntime =
      commandLine.toLowerCase().includes(repoRoot) && /^(node|bun|electron)(\.exe)?$/i.test(name);
    if (isRepoLocalRuntime || matchesPattern(haystack)) {
      addChain(pid);
    }
  }

  for (const ownerPid of portOwners) {
    addChain(ownerPid);
  }

  const orderedTargets = [...targets].sort((a, b) => b - a);
  for (const pid of orderedTargets) {
    Bun.spawnSync(["taskkill.exe", "/PID", String(pid), "/T", "/F"], {
      stdout: "ignore",
      stderr: "ignore",
    });
  }
}

export function killDashboardProcesses(): void {
  if (process.platform === "win32") {
    killMatchingWindowsProcesses();
    return;
  }
  killMatchingPosixProcesses();
}

if (import.meta.main) {
  killDashboardProcesses();
}
