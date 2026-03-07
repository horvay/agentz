import type { ElectrobunConfig } from "electrobun";

export default {
	app: {
		name: "ghostty-dashboard-mvp",
		identifier: "ghosttydashboard.electrobun.dev",
		version: "0.0.1",
	},
	build: {
		// Vite builds to dist/, we copy from there
		copy: {
			"dist/index.html": "views/mainview/index.html",
			"dist/assets": "views/mainview/assets",
			"node_modules/node-pty/lib": "bun/node-pty/lib",
			"node_modules/node-pty/prebuilds": "bun/node-pty/prebuilds",
			"src/native/zig-out/bin/ghostty-vt-bridge": "bin/ghostty-vt-bridge",
		},
		mac: {
			bundleCEF: false,
		},
		linux: {
			bundleCEF: false,
		},
		win: {
			bundleCEF: false,
		},
	},
	scripts: {
		postBuild: "scripts/post-build-wrap-launcher.ts",
		postPackage: "scripts/post-package-linux-setup.ts",
	},
} satisfies ElectrobunConfig;
