import type { ElectrobunConfig } from "electrobun";

export default {
	app: {
		name: "agentz",
		identifier: "ghosttydashboard.electrobun.dev",
		version: "0.0.1",
	},
	build: {
		// Vite builds to dist/, we copy from there
		copy: {
			"dist/index.html": "views/mainview/index.html",
			"dist/assets": "views/mainview/assets",
			"src/native/zig-out/bin/ghostty-pty-host": "bin/ghostty-pty-host",
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
