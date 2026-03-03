const std = @import("std");

pub fn build(b: *std.Build) void {
    const target = b.standardTargetOptions(.{});
    const optimize = b.standardOptimizeOption(.{});

    const exe = b.addExecutable(.{
        .name = "ghostty-vt-bridge",
        .root_module = b.createModule(.{
            .root_source_file = b.path("ghostty_bridge.zig"),
            .target = target,
            .optimize = optimize,
        }),
    });

    if (b.lazyDependency("ghostty", .{})) |dep| {
        exe.root_module.addImport(
            "ghostty-vt",
            dep.module("ghostty-vt"),
        );
    }

    exe.linkLibC();

    b.installArtifact(exe);
}
