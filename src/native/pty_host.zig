const builtin = @import("builtin");

comptime {
    if (builtin.os.tag == .windows) {
        _ = @import("pty_host_windows.zig");
    } else {
        _ = @import("pty_host_posix.zig");
    }
}

pub fn main() !void {
    if (builtin.os.tag == .windows) {
        return @import("pty_host_windows.zig").main();
    }
    return @import("pty_host_posix.zig").main();
}
