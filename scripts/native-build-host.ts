import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolveBundledZig, runInherited } from "./runtime";

function ensureGhosttyLibVtBuildPatch(rootDir: string): void {
  const ghosttyBuildPath = join(rootDir, "deps", "ghostty", "build.zig");
  const ghosttyConfigPath = join(rootDir, "deps", "ghostty", "src", "build", "Config.zig");
  const ghosttySharedDepsPath = join(rootDir, "deps", "ghostty", "src", "build", "SharedDeps.zig");

  const configSource = readFileSync(ghosttyConfigPath, "utf8");
  const source = readFileSync(ghosttyBuildPath, "utf8");
  const nl = source.includes("\r\n") ? "\r\n" : "\n";
  const optionAnchor = `    const config = try buildpkg.Config.init(b, appVersion);${nl}`;
  const isDepBlock =
    `    const is_dep = dep: {${nl}` +
    `        b.build_root.handle.access(@src().file, .{}) catch break :dep true;${nl}` +
    `        break :dep false;${nl}` +
    `    };${nl}`;
  const optionBlock =
    `    const emit_lib_vt = b.option(${nl}` +
    `        bool,${nl}` +
    `        "emit-lib-vt",${nl}` +
    `        "Build only the exported VT modules/artifacts for downstream consumers.",${nl}` +
    `    ) orelse false;${nl}`;
  const oldOptionBlock = optionBlock + isDepBlock;
  const guardAnchor =
    `    // Ghostty dependencies used by many artifacts.${nl}`;
  const legacyGuardBlock =
    `    // Downstream VT-only consumers only need the exported Zig modules.${nl}` +
    `    // Avoid instantiating the full app/docs/bench dependency graph.${nl}` +
    `    if (emit_lib_vt) {${nl}` +
    `        const deps = try buildpkg.SharedDeps.initLibVt(b, &config);${nl}` +
    `        _ = try buildpkg.GhosttyZig.init(b, &config, &deps);${nl}` +
    `        return;${nl}` +
    `    }${nl}` +
    nl;
  const oldLegacyGuardBlock =
    `    // Downstream VT-only consumers only need the exported Zig modules.${nl}` +
    `    // Avoid instantiating the full app/docs/bench graph here because it pulls${nl}` +
    `    // in vendored font and image packages that are unrelated to libghostty-vt.${nl}` +
    `    if (emit_lib_vt and is_dep) {${nl}` +
    `        return;${nl}` +
    `    }${nl}` +
    nl;
  const oldConfigGuardBlock =
    `    // Downstream VT-only consumers only need the exported Zig modules.${nl}` +
    `    // Avoid instantiating the full app/docs/bench graph here because it pulls${nl}` +
    `    // in vendored font and image packages that are unrelated to libghostty-vt.${nl}` +
    `    if (config.emit_lib_vt and config.is_dep) {${nl}` +
    `        return;${nl}` +
    `    }${nl}` +
    nl;
  const configGuardBlock =
    `    // Downstream VT-only consumers only need the exported Zig modules.${nl}` +
    `    // Avoid instantiating the full app/docs/bench dependency graph.${nl}` +
    `    if (config.emit_lib_vt) {${nl}` +
    `        const deps = try buildpkg.SharedDeps.initLibVt(b, &config);${nl}` +
    `        _ = try buildpkg.GhosttyZig.init(b, &config, &deps);${nl}` +
    `        return;${nl}` +
    `    }${nl}` +
    nl;
  const supportsConfigFields =
    configSource.includes("emit_lib_vt:") && configSource.includes("is_dep:");
  let next = source;

  if (supportsConfigFields) {
    next = next.replace(optionBlock, "");
    next = next.replace(oldLegacyGuardBlock, configGuardBlock);
    next = next.replace(oldConfigGuardBlock, configGuardBlock);
    next = next.replace(legacyGuardBlock, configGuardBlock);
  } else {
    next = next.replace(oldOptionBlock, optionBlock);
    next = next.replace(isDepBlock, "");
    if (!next.includes(optionBlock)) {
      if (!next.includes(optionAnchor)) {
        throw new Error(`Unable to patch ${ghosttyBuildPath}: missing config anchor`);
      }
      next = next.replace(optionAnchor, optionAnchor + optionBlock);
    }
    next = next.replace(oldLegacyGuardBlock, legacyGuardBlock);
    next = next.replace(oldConfigGuardBlock, legacyGuardBlock);
    next = next.replace(configGuardBlock, legacyGuardBlock);
  }

  next = next.replace(legacyGuardBlock, "");
  next = next.replace(configGuardBlock, "");
  next = next.replace(legacyGuardBlock.replace("if (emit_lib_vt)", "if (emit_lib_vt and is_dep)"), "");
  next = next.replace(configGuardBlock.replace("if (config.emit_lib_vt)", "if (config.emit_lib_vt and config.is_dep)"), "");

  if (
    !next.includes("buildpkg.SharedDeps.initLibVt")
  ) {
    if (!next.includes(guardAnchor)) {
      throw new Error(`Unable to patch ${ghosttyBuildPath}: missing resource anchor`);
    }
    next = next.replace(
      guardAnchor,
      (supportsConfigFields ? configGuardBlock : legacyGuardBlock) + guardAnchor,
    );
  }

  if (next !== source) {
    writeFileSync(ghosttyBuildPath, next);
  }

  const sharedDepsSource = readFileSync(ghosttySharedDepsPath, "utf8");
  const sharedDepsNl = sharedDepsSource.includes("\r\n") ? "\r\n" : "\n";
  const sharedDepsAnchor = `pub fn init(b: *std.Build, cfg: *const Config) !SharedDeps {${sharedDepsNl}`;
  const sharedDepsPatch =
    `pub fn initLibVt(b: *std.Build, cfg: *const Config) !SharedDeps {${sharedDepsNl}` +
    `    const uucode_tables = blk: {${sharedDepsNl}` +
    `        const uucode = b.dependency("uucode", .{${sharedDepsNl}` +
    `            .build_config_path = b.path("src/build/uucode_config.zig"),${sharedDepsNl}` +
    `        });${sharedDepsNl}` +
    sharedDepsNl +
    `        break :blk uucode.namedLazyPath("tables.zig");${sharedDepsNl}` +
    `    };${sharedDepsNl}` +
    sharedDepsNl +
    `    var result: SharedDeps = .{${sharedDepsNl}` +
    `        .config = cfg,${sharedDepsNl}` +
    `        .help_strings = undefined,${sharedDepsNl}` +
    `        .unicode_tables = try .init(b, uucode_tables),${sharedDepsNl}` +
    `        .framedata = undefined,${sharedDepsNl}` +
    `        .uucode_tables = uucode_tables,${sharedDepsNl}` +
    `        .options = undefined,${sharedDepsNl}` +
    `        .metallib = undefined,${sharedDepsNl}` +
    `    };${sharedDepsNl}` +
    `    try result.initTarget(b, cfg.target);${sharedDepsNl}` +
    `    if (cfg.emit_unicode_table_gen) result.unicode_tables.install(b);${sharedDepsNl}` +
    `    return result;${sharedDepsNl}` +
    `}${sharedDepsNl}` +
    sharedDepsNl;
  if (!sharedDepsSource.includes("pub fn initLibVt(")) {
    if (!sharedDepsSource.includes(sharedDepsAnchor)) {
      throw new Error(`Unable to patch ${ghosttySharedDepsPath}: missing init anchor`);
    }
    writeFileSync(
      ghosttySharedDepsPath,
      sharedDepsSource.replace(sharedDepsAnchor, sharedDepsPatch + sharedDepsAnchor),
    );
  }
}

const rootDir = process.cwd();
ensureGhosttyLibVtBuildPatch(rootDir);
const zig = resolveBundledZig(rootDir);
const zigCode = await runInherited([zig, "build", "-Doptimize=ReleaseFast"], {
  cwd: join(rootDir, "src", "native"),
});
if (zigCode !== 0) {
  process.exit(zigCode);
}

process.exit(0);
