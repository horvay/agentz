const std = @import("std");

pub fn build(b: *std.Build) void {
    const target = b.standardTargetOptions(.{});
    const optimize = b.standardOptimizeOption(.{});

    const host = b.addExecutable(.{
        .name = "ghostty-pty-host",
        .root_module = b.createModule(.{
            .root_source_file = b.path("pty_host.zig"),
            .target = target,
            .optimize = optimize,
        }),
    });

    if (b.lazyDependency("ghostty", .{})) |dep| {
        host.root_module.addImport(
            "ghostty-vt",
            dep.module("ghostty-vt"),
        );
    }

    host.linkLibC();

    b.installArtifact(host);
}
