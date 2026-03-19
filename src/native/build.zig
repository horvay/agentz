const std = @import("std");

pub fn build(b: *std.Build) void {
    const target = b.standardTargetOptions(.{});
    const optimize = b.standardOptimizeOption(.{});

    const host = b.addExecutable(.{
        .name = "agentz-pty-host",
        .root_module = b.createModule(.{
            .root_source_file = b.path("pty_host.zig"),
            .target = target,
            .optimize = optimize,
        }),
    });

    if (b.lazyDependency("ghostty", .{
        .@"emit-macos-app" = false,
        .@"emit-xcframework" = false,
    })) |dep| {
        host.root_module.addImport(
            "ghostty-vt",
            dep.module("ghostty-vt"),
        );
    }

    host.linkLibC();
    switch (target.result.os.tag) {
        .linux, .freebsd, .openbsd, .netbsd, .dragonfly => {
            host.linkSystemLibrary("util");
        },
        else => {},
    }
    if (target.result.os.tag.isDarwin()) {
        host.linkSystemLibrary("proc");
    }

    b.installArtifact(host);
}
