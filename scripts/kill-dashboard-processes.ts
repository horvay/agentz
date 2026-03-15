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

function getProtectedPids(): Set<number> {
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

const protectedPids = getProtectedPids();

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
