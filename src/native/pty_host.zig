const std = @import("std");
const builtin = @import("builtin");
const ghostty_vt = @import("ghostty-vt");
const c = @cImport({
    @cInclude("errno.h");
    @cInclude("fcntl.h");
    if (builtin.target.os.tag.isDarwin()) {
        @cInclude("libproc.h");
        @cInclude("sys/proc_info.h");
        @cInclude("util.h");
    } else {
        @cInclude("pty.h");
    }
    @cInclude("poll.h");
    @cInclude("signal.h");
    @cInclude("stdio.h");
    @cInclude("stdlib.h");
    @cInclude("string.h");
    @cInclude("sys/ioctl.h");
    @cInclude("termios.h");
    @cInclude("sys/types.h");
    @cInclude("sys/wait.h");
    @cInclude("unistd.h");
});

const BUSY_POLL_INTERVAL_MS: i64 = 700;

const StartupConfig = struct {
    command: []const u8,
    args: []const []const u8 = &.{},
    cwd: []const u8,
    cols: u16 = 120,
    rows: u16 = 36,
};

const Command = struct {
    type: []const u8,
    data: ?[]const u8 = null,
    data_b64: ?[]const u8 = null,
    cols: ?u16 = null,
    rows: ?u16 = null,
    paused: ?bool = null,
    encoding: ?[]const u8 = null,
};

const DataMessage = struct {
    type: []const u8 = "data",
    data: []const u8,
};

const ExitMessage = struct {
    type: []const u8 = "exit",
    code: i32,
};

const CwdMessage = struct {
    type: []const u8 = "cwd",
    cwd: []const u8,
};

const BusyMessage = struct {
    type: []const u8 = "busy",
    busy: bool,
    at_ms: i64,
};

const FrameMode = enum {
    full,
    patch,
};

const FrameMessage = struct {
    type: []const u8 = "frame",
    mode: FrameMode,
    vt_b64: []const u8,
    plain_b64: []const u8,
    patch_kind: ?[]const u8 = null,
    cols: u16,
    rows: u16,
    alt_screen: bool,
    cursor_visible: bool,
    cursor_style: []const u8,
    cursor_blink: bool,
    cursor_row: u16,
    cursor_col: u16,
    mouse_tracking_mode: []const u8,
    mouse_format: []const u8,
    focus_event: bool,
    mouse_alternate_scroll: bool,
};

const OwnedRows = std.ArrayList([]u8);

const ExecSpec = struct {
    command_z: [:0]u8,
    arg_storage: std.ArrayList([:0]u8),
    argv_ptrs: std.ArrayList(?[*:0]u8),

    fn init(alloc: std.mem.Allocator, config: StartupConfig) !ExecSpec {
        var spec = ExecSpec{
            .command_z = try alloc.dupeZ(u8, config.command),
            .arg_storage = .empty,
            .argv_ptrs = .empty,
        };
        errdefer spec.deinit(alloc);

        try spec.argv_ptrs.append(alloc, spec.command_z.ptr);
        for (config.args) |arg| {
            const arg_z = try alloc.dupeZ(u8, arg);
            try spec.arg_storage.append(alloc, arg_z);
            try spec.argv_ptrs.append(alloc, arg_z.ptr);
        }
        try spec.argv_ptrs.append(alloc, null);
        return spec;
    }

    fn deinit(self: *ExecSpec, alloc: std.mem.Allocator) void {
        alloc.free(self.command_z);
        for (self.arg_storage.items) |arg| alloc.free(arg);
        self.arg_storage.deinit(alloc);
        self.argv_ptrs.deinit(alloc);
    }
};

fn isAltScreen(term: *ghostty_vt.Terminal) bool {
    return term.modes.get(.alt_screen_save_cursor_clear_enter) or
        term.modes.get(.alt_screen) or
        term.modes.get(.alt_screen_legacy);
}

fn writeModePrefix(writer: *std.Io.Writer, term: *ghostty_vt.Terminal) !void {
    if (term.modes.get(.origin)) {
        try writer.writeAll("\x1b[?6h");
    } else {
        try writer.writeAll("\x1b[?6l");
    }
    if (term.modes.get(.enable_left_and_right_margin)) {
        try writer.writeAll("\x1b[?69h");
    } else {
        try writer.writeAll("\x1b[?69l");
    }
}

fn writeScrollingRegion(writer: *std.Io.Writer, term: *ghostty_vt.Terminal) !void {
    var formatter: ghostty_vt.formatter.TerminalFormatter = .init(term, .{ .emit = .vt });
    formatter.content = .none;
    formatter.extra = .{
        .palette = false,
        .modes = false,
        .scrolling_region = true,
        .tabstops = false,
        .pwd = false,
        .keyboard = false,
        .screen = .none,
    };
    try formatter.format(writer);
}

fn writeCursorState(writer: *std.Io.Writer, term: *ghostty_vt.Terminal) !void {
    const cursor_style_code: u8 = switch (term.screens.active.cursor.cursor_style) {
        .block, .block_hollow => if (term.modes.get(.cursor_blinking)) 1 else 2,
        .underline => if (term.modes.get(.cursor_blinking)) 3 else 4,
        .bar => if (term.modes.get(.cursor_blinking)) 5 else 6,
    };

    try writer.print("\x1b[{d} q", .{cursor_style_code});
    try writer.writeAll(if (term.modes.get(.cursor_visible)) "\x1b[?25h" else "\x1b[?25l");

    var formatter: ghostty_vt.formatter.TerminalFormatter = .init(term, .{ .emit = .vt });
    formatter.content = .none;
    formatter.extra = .none;
    formatter.extra.screen.cursor = true;
    try formatter.format(writer);
    const cursor = term.screens.active.cursor;
    try writer.print("\x1b[{d};{d}H", .{
        @as(usize, @intCast(cursor.y)) + 1,
        @as(usize, @intCast(cursor.x)) + 1,
    });
}

fn formatRow(
    alloc: std.mem.Allocator,
    term: *ghostty_vt.Terminal,
    row_index: usize,
    emit: ghostty_vt.formatter.Format,
) ![]u8 {
    const screen = term.screens.active;
    const cols: usize = @intCast(term.cols);
    if (cols == 0) return try alloc.dupe(u8, "");

    const y: ghostty_vt.size.CellCountInt = @intCast(row_index);
    const start_pin = screen.pages.pin(.{ .active = .{
        .x = 0,
        .y = y,
    } }) orelse return try alloc.dupe(u8, "");
    const end_pin = screen.pages.pin(.{ .active = .{
        .x = @intCast(cols - 1),
        .y = y,
    } }) orelse return try alloc.dupe(u8, "");

    const selection = ghostty_vt.Selection.init(start_pin, end_pin, true);

    var formatter: ghostty_vt.formatter.ScreenFormatter = .init(screen, .{
        .emit = emit,
        .trim = false,
        .unwrap = false,
    });
    formatter.content = .{ .selection = selection };
    formatter.extra = .none;

    var builder: std.Io.Writer.Allocating = .init(alloc);
    defer builder.deinit();
    try formatter.format(&builder.writer);
    return try alloc.dupe(u8, builder.writer.buffered());
}

fn captureRows(alloc: std.mem.Allocator, term: *ghostty_vt.Terminal, emit: ghostty_vt.formatter.Format) !OwnedRows {
    var rows: OwnedRows = .empty;
    errdefer {
        for (rows.items) |row| alloc.free(row);
        rows.deinit(alloc);
    }

    for (0..@as(usize, @intCast(term.rows))) |row_index| {
        const row = try formatRow(alloc, term, row_index, emit);
        try rows.append(alloc, row);
    }

    return rows;
}

fn freeOwnedRows(alloc: std.mem.Allocator, rows: *OwnedRows) void {
    for (rows.items) |row| alloc.free(row);
    rows.clearRetainingCapacity();
}

fn replaceOwnedRows(alloc: std.mem.Allocator, dest: *OwnedRows, src: *OwnedRows) void {
    freeOwnedRows(alloc, dest);
    dest.* = src.*;
    src.* = .empty;
}

fn joinRows(alloc: std.mem.Allocator, rows: []const []u8) ![]u8 {
    var builder: std.Io.Writer.Allocating = .init(alloc);
    defer builder.deinit();
    for (rows, 0..) |row, idx| {
        if (idx > 0) try builder.writer.writeByte('\n');
        try builder.writer.writeAll(row);
    }
    return try alloc.dupe(u8, builder.writer.buffered());
}

fn buildFullVt(alloc: std.mem.Allocator, term: *ghostty_vt.Terminal, current_render_rows: []const []u8) ![]u8 {
    var builder: std.Io.Writer.Allocating = .init(alloc);
    defer builder.deinit();

    try writeModePrefix(&builder.writer, term);
    try writeScrollingRegion(&builder.writer, term);

    for (current_render_rows, 0..) |row_vt, row_index| {
        try builder.writer.print("\x1b[{d};1H\x1b[2K", .{row_index + 1});
        if (row_vt.len > 0) {
            try builder.writer.writeAll(row_vt);
        }
    }

    try writeCursorState(&builder.writer, term);
    return try alloc.dupe(u8, builder.writer.buffered());
}

fn buildPatchVt(
    alloc: std.mem.Allocator,
    term: *ghostty_vt.Terminal,
    previous_render_rows: []const []u8,
    current_render_rows: []const []u8,
) ![]u8 {
    var builder: std.Io.Writer.Allocating = .init(alloc);
    defer builder.deinit();

    try writeModePrefix(&builder.writer, term);
    try writeScrollingRegion(&builder.writer, term);

    for (current_render_rows, 0..) |row_vt, row_index| {
        if (std.mem.eql(u8, previous_render_rows[row_index], row_vt)) continue;

        try builder.writer.print("\x1b[{d};1H\x1b[2K", .{row_index + 1});
        if (row_vt.len == 0) continue;
        try builder.writer.writeAll(row_vt);
    }

    try writeCursorState(&builder.writer, term);
    return try alloc.dupe(u8, builder.writer.buffered());
}

fn writeFrame(
    alloc: std.mem.Allocator,
    stdout_writer: *std.Io.Writer,
    mode: FrameMode,
    vt: []const u8,
    plain: []const u8,
    patch_kind: ?[]const u8,
    term: *ghostty_vt.Terminal,
    alt_screen: bool,
) !void {
    const vt_b64_len = std.base64.standard.Encoder.calcSize(vt.len);
    const plain_b64_len = std.base64.standard.Encoder.calcSize(plain.len);

    const vt_b64 = try alloc.alloc(u8, vt_b64_len);
    defer alloc.free(vt_b64);
    _ = std.base64.standard.Encoder.encode(vt_b64, vt);

    const plain_b64 = try alloc.alloc(u8, plain_b64_len);
    defer alloc.free(plain_b64);
    _ = std.base64.standard.Encoder.encode(plain_b64, plain);

    try std.json.Stringify.value(
        FrameMessage{
            .mode = mode,
            .vt_b64 = vt_b64,
            .plain_b64 = plain_b64,
            .patch_kind = patch_kind,
            .cols = @as(u16, @intCast(term.cols)),
            .rows = @as(u16, @intCast(term.rows)),
            .alt_screen = alt_screen,
            .cursor_visible = term.modes.get(.cursor_visible),
            .cursor_style = switch (term.screens.active.cursor.cursor_style) {
                .block => "block",
                .block_hollow => "block",
                .underline => "underline",
                .bar => "bar",
            },
            .cursor_blink = term.modes.get(.cursor_blinking),
            .cursor_row = @as(u16, @intCast(term.screens.active.cursor.y)) + 1,
            .cursor_col = @as(u16, @intCast(term.screens.active.cursor.x)) + 1,
            .mouse_tracking_mode = switch (term.flags.mouse_event) {
                .none => "none",
                .x10 => "x10",
                .normal => "normal",
                .button => "button",
                .any => "any",
            },
            .mouse_format = switch (term.flags.mouse_format) {
                .x10 => "x10",
                .utf8 => "utf8",
                .sgr => "sgr",
                .urxvt => "urxvt",
                .sgr_pixels => "sgr-pixels",
            },
            .focus_event = term.modes.get(.focus_event),
            .mouse_alternate_scroll = term.modes.get(.mouse_alternate_scroll),
        },
        .{},
        stdout_writer,
    );
    try stdout_writer.writeByte('\n');
    try stdout_writer.flush();
}

fn emitFrame(
    alloc: std.mem.Allocator,
    stdout_writer: *std.Io.Writer,
    term: *ghostty_vt.Terminal,
    previous_render_rows: *OwnedRows,
    previous_alt_screen: *bool,
    has_snapshot: *bool,
    force_full: bool,
) !void {
    const alt_screen = isAltScreen(term);
    var current_render_rows = try captureRows(alloc, term, .vt);
    defer {
        freeOwnedRows(alloc, &current_render_rows);
        current_render_rows.deinit(alloc);
    }

    var mode: FrameMode = .patch;
    var use_full = force_full or
        !has_snapshot.* or
        previous_alt_screen.* != alt_screen or
        previous_render_rows.items.len != current_render_rows.items.len;

    var dirty_rows: usize = 0;
    var first_dirty_row: ?usize = null;
    var last_dirty_row: ?usize = null;
    if (!use_full) {
        for (current_render_rows.items, 0..) |row, idx| {
            if (!std.mem.eql(u8, previous_render_rows.items[idx], row)) {
                dirty_rows += 1;
                if (first_dirty_row == null) first_dirty_row = idx;
                last_dirty_row = idx;
            }
        }

        const cursor_row: usize = @intCast(term.screens.active.cursor.y);
        const patchable_cursor_only = dirty_rows == 0;
        const patchable_cursor_row_only = dirty_rows == 1 and
            first_dirty_row != null and
            first_dirty_row.? == cursor_row and
            last_dirty_row != null and
            last_dirty_row.? == cursor_row;
        const patchable_alt_small_block = alt_screen and
            dirty_rows > 0 and
            dirty_rows <= 4 and
            first_dirty_row != null and
            last_dirty_row != null and
            (last_dirty_row.? - first_dirty_row.? + 1) == dirty_rows;

        const allow_patch = if (alt_screen)
            patchable_cursor_only or patchable_alt_small_block
        else
            patchable_cursor_only or patchable_cursor_row_only;

        if (!allow_patch) {
            use_full = true;
        }
    }

    const patch_kind: ?[]const u8 = if (use_full)
        null
    else if (dirty_rows == 0)
        "cursor-only"
    else if (alt_screen)
        "alt-row-update"
    else
        "row-update";

    var current_plain_rows: OwnedRows = .empty;
    var has_plain_rows = false;
    defer if (has_plain_rows) {
        freeOwnedRows(alloc, &current_plain_rows);
        current_plain_rows.deinit(alloc);
    };

    const include_plain = if (patch_kind == null)
        true
    else if (std.mem.eql(u8, patch_kind.?, "row-update") or std.mem.eql(u8, patch_kind.?, "alt-row-update"))
        true
    else
        false;

    const plain = if (!include_plain)
        try alloc.dupe(u8, "")
    else blk: {
        current_plain_rows = try captureRows(alloc, term, .plain);
        has_plain_rows = true;
        break :blk try joinRows(alloc, current_plain_rows.items);
    };
    defer alloc.free(plain);

    const vt = if (use_full) blk: {
        mode = .full;
        break :blk try buildFullVt(alloc, term, current_render_rows.items);
    } else blk: {
        mode = .patch;
        break :blk try buildPatchVt(alloc, term, previous_render_rows.items, current_render_rows.items);
    };
    defer alloc.free(vt);

    try writeFrame(alloc, stdout_writer, mode, vt, plain, patch_kind, term, alt_screen);
    replaceOwnedRows(alloc, previous_render_rows, &current_render_rows);
    previous_alt_screen.* = alt_screen;
    has_snapshot.* = true;
}

fn writeJsonLine(stdout_writer: *std.Io.Writer, value: anytype) !void {
    try std.json.Stringify.value(value, .{}, stdout_writer);
    try stdout_writer.writeByte('\n');
    try stdout_writer.flush();
}

fn emitData(alloc: std.mem.Allocator, stdout_writer: *std.Io.Writer, bytes: []const u8) !void {
    const encoded_len = std.base64.standard.Encoder.calcSize(bytes.len);
    const encoded = try alloc.alloc(u8, encoded_len);
    defer alloc.free(encoded);
    _ = std.base64.standard.Encoder.encode(encoded, bytes);
    try writeJsonLine(stdout_writer, DataMessage{ .data = encoded });
}

fn emitExit(stdout_writer: *std.Io.Writer, code: i32) !void {
    try writeJsonLine(stdout_writer, ExitMessage{ .code = code });
}

fn readProcPath(alloc: std.mem.Allocator, path: []const u8) ![]u8 {
    return std.fs.cwd().readFileAlloc(alloc, path, 4096);
}

fn resolveTermCwd(alloc: std.mem.Allocator, child_pid: c.pid_t, fallback: []const u8) ![]u8 {
    if (builtin.target.os.tag.isDarwin()) {
        var vnode_info: c.struct_proc_vnodepathinfo = undefined;
        const info_len = c.proc_pidinfo(
            child_pid,
            c.PROC_PIDVNODEPATHINFO,
            0,
            &vnode_info,
            @sizeOf(c.struct_proc_vnodepathinfo),
        );
        if (info_len == c.PROC_PIDVNODEPATHINFO_SIZE) {
            const raw_path = std.mem.sliceTo(&vnode_info.pvi_cdir.vip_path, 0);
            if (raw_path.len > 0) {
                return try alloc.dupe(u8, raw_path);
            }
        }
        return try alloc.dupe(u8, fallback);
    }
    const proc_path = try std.fmt.allocPrint(alloc, "/proc/{d}/cwd", .{child_pid});
    defer alloc.free(proc_path);
    return std.fs.cwd().realpathAlloc(alloc, proc_path) catch try alloc.dupe(u8, fallback);
}

fn publishCwd(
    alloc: std.mem.Allocator,
    stdout_writer: *std.Io.Writer,
    child_pid: c.pid_t,
    last_known_cwd: *[]u8,
    last_published_cwd: *[]u8,
    force: bool,
) !void {
    const next = try resolveTermCwd(alloc, child_pid, last_known_cwd.*);
    defer alloc.free(next);

    if (!std.mem.eql(u8, next, last_known_cwd.*)) {
        alloc.free(last_known_cwd.*);
        last_known_cwd.* = try alloc.dupe(u8, next);
    }
    if (!force and std.mem.eql(u8, next, last_published_cwd.*)) return;

    alloc.free(last_published_cwd.*);
    last_published_cwd.* = try alloc.dupe(u8, next);
    try writeJsonLine(stdout_writer, CwdMessage{ .cwd = next });
}

fn listChildPidsAlloc(alloc: std.mem.Allocator, child_pid: c.pid_t) ![]u8 {
    if (builtin.target.os.tag.isDarwin()) {
        var pid_buf: [4096]u8 = undefined;
        const bytes = c.proc_listchildpids(child_pid, &pid_buf, pid_buf.len);
        if (bytes <= 0) return try alloc.dupe(u8, "");
        const pid_count: usize = @intCast(@divTrunc(bytes, @sizeOf(c.pid_t)));
        const pid_slice = std.mem.bytesAsSlice(c.pid_t, pid_buf[0..@intCast(bytes)]);
        var builder: std.Io.Writer.Allocating = .init(alloc);
        defer builder.deinit();
        for (pid_slice[0..pid_count], 0..) |pid, idx| {
            if (pid <= 0) continue;
            if (idx > 0) try builder.writer.writeByte(' ');
            try builder.writer.print("{d}", .{pid});
        }
        return try alloc.dupe(u8, builder.writer.buffered());
    }
    const children_path = try std.fmt.allocPrint(alloc, "/proc/{d}/task/{d}/children", .{ child_pid, child_pid });
    defer alloc.free(children_path);
    return readProcPath(alloc, children_path) catch try alloc.dupe(u8, "");
}

fn resolveBusyState(alloc: std.mem.Allocator, master_fd: c_int, child_pid: c.pid_t) !bool {
    const shell_pgrp = c.getpgid(child_pid);
    const foreground_pgrp = c.tcgetpgrp(master_fd);
    if (shell_pgrp > 0 and foreground_pgrp > 0 and foreground_pgrp != shell_pgrp) {
        return true;
    }

    const raw = try listChildPidsAlloc(alloc, child_pid);
    defer alloc.free(raw);
    var iter = std.mem.tokenizeAny(u8, raw, " \t\r\n");
    while (iter.next()) |_| return true;
    return false;
}

fn publishBusyState(
    alloc: std.mem.Allocator,
    stdout_writer: *std.Io.Writer,
    master_fd: c_int,
    child_pid: c.pid_t,
    last_busy_state: *bool,
    force: bool,
) !void {
    const next_busy = resolveBusyState(alloc, master_fd, child_pid) catch false;
    if (!force and next_busy == last_busy_state.*) return;
    last_busy_state.* = next_busy;
    try writeJsonLine(stdout_writer, BusyMessage{ .busy = next_busy, .at_ms = std.time.milliTimestamp() });
}

fn decodeInput(alloc: std.mem.Allocator, encoded: []const u8) ![]u8 {
    const decoded_len = try std.base64.standard.Decoder.calcSizeForSlice(encoded);
    const decoded = try alloc.alloc(u8, decoded_len);
    errdefer alloc.free(decoded);
    _ = try std.base64.standard.Decoder.decode(decoded, encoded);
    return decoded;
}

fn applyResize(master_fd: c_int, term: *ghostty_vt.Terminal, alloc: std.mem.Allocator, cols: u16, rows: u16) !void {
    var winsize = c.struct_winsize{
        .ws_row = rows,
        .ws_col = cols,
        .ws_xpixel = 0,
        .ws_ypixel = 0,
    };
    if (c.ioctl(master_fd, c.TIOCSWINSZ, &winsize) != 0) {
        return error.ResizeIoctlFailed;
    }
    try term.resize(alloc, cols, rows);
}

fn extractExitCode(status: c_int) i32 {
    if (c.WIFEXITED(status)) return c.WEXITSTATUS(status);
    if (c.WIFSIGNALED(status)) return 128 + c.WTERMSIG(status);
    return 0;
}

fn reapChild(child_pid: c.pid_t) ?i32 {
    var status: c_int = 0;
    const waited = c.waitpid(child_pid, &status, c.WNOHANG);
    if (waited == 0) return null;
    if (waited < 0) return 1;
    return extractExitCode(status);
}

fn spawnChild(cwd_z: [:0]u8, exec_spec: *const ExecSpec, winsize: *c.struct_winsize) !struct { master_fd: c_int, child_pid: c.pid_t } {
    var master_fd: c_int = -1;
    const child_pid = c.forkpty(&master_fd, null, null, winsize);
    if (child_pid < 0) return error.ForkPtyFailed;

    if (child_pid == 0) {
        if (c.chdir(cwd_z.ptr) != 0) {
            _ = c.perror("chdir");
            c._exit(127);
        }
        _ = c.setenv("TERM", "xterm-256color", 1);
        _ = c.setenv("COLORTERM", "truecolor", 1);
        _ = c.execvp(exec_spec.command_z.ptr, @ptrCast(exec_spec.argv_ptrs.items.ptr));
        _ = c.perror("execvp");
        c._exit(127);
    }

    return .{ .master_fd = master_fd, .child_pid = child_pid };
}

pub fn main() !void {
    var gpa: std.heap.DebugAllocator(.{}) = .init;
    defer _ = gpa.deinit();
    const alloc = gpa.allocator();

    var args = try std.process.argsWithAllocator(alloc);
    defer args.deinit();

    _ = args.next();
    const startup_json = args.next() orelse return error.MissingStartupConfig;

    var startup_parsed = try std.json.parseFromSlice(StartupConfig, alloc, startup_json, .{
        .ignore_unknown_fields = true,
    });
    defer startup_parsed.deinit();
    const startup = startup_parsed.value;

    var term: ghostty_vt.Terminal = try .init(alloc, .{
        .cols = startup.cols,
        .rows = startup.rows,
    });
    defer term.deinit(alloc);

    var stream = term.vtStream();
    defer stream.deinit();

    var previous_render_rows: OwnedRows = .empty;
    defer {
        freeOwnedRows(alloc, &previous_render_rows);
        previous_render_rows.deinit(alloc);
    }
    var previous_alt_screen = false;
    var has_snapshot = false;

    var stdout_file = std.fs.File.stdout();
    var stdout_buf: [4096]u8 = undefined;
    var stdout_writer_state = stdout_file.writer(&stdout_buf);
    const stdout_writer = &stdout_writer_state.interface;

    const cwd_z = try alloc.dupeZ(u8, startup.cwd);
    defer alloc.free(cwd_z);
    var exec_spec = try ExecSpec.init(alloc, startup);
    defer exec_spec.deinit(alloc);

    var winsize = c.struct_winsize{
        .ws_row = startup.rows,
        .ws_col = startup.cols,
        .ws_xpixel = 0,
        .ws_ypixel = 0,
    };
    const child = try spawnChild(cwd_z, &exec_spec, &winsize);
    const master_fd = child.master_fd;
    const child_pid = child.child_pid;
    defer {
        if (master_fd >= 0) _ = c.close(master_fd);
    }

    var last_known_cwd = try alloc.dupe(u8, startup.cwd);
    defer alloc.free(last_known_cwd);
    var last_published_cwd = try alloc.dupe(u8, startup.cwd);
    defer alloc.free(last_published_cwd);
    var last_busy_state = false;
    var last_busy_poll_ms = std.time.milliTimestamp();
    var flow_paused = false;
    var stdin_open = true;
    var child_done = false;

    try emitFrame(alloc, stdout_writer, &term, &previous_render_rows, &previous_alt_screen, &has_snapshot, true);
    try publishBusyState(alloc, stdout_writer, master_fd, child_pid, &last_busy_state, true);
    try publishCwd(alloc, stdout_writer, child_pid, &last_known_cwd, &last_published_cwd, true);

    var stdin_buffer = std.ArrayList(u8).empty;
    defer stdin_buffer.deinit(alloc);

    while (!child_done) {
        var pollfds: [2]c.struct_pollfd = undefined;
        var poll_count: usize = 0;

        if (stdin_open) {
            pollfds[poll_count] = .{ .fd = 0, .events = c.POLLIN | c.POLLHUP | c.POLLERR, .revents = 0 };
            poll_count += 1;
        }
        if (!flow_paused) {
            pollfds[poll_count] = .{ .fd = master_fd, .events = c.POLLIN | c.POLLHUP | c.POLLERR, .revents = 0 };
            poll_count += 1;
        }

        const poll_rc = c.poll(&pollfds, @intCast(poll_count), 100);
        if (poll_rc < 0) {
            return error.PollFailed;
        }

        var index: usize = 0;
        if (stdin_open) {
            const events = pollfds[index].revents;
            if ((events & (c.POLLIN | c.POLLHUP | c.POLLERR)) != 0) {
                var read_buf: [8192]u8 = undefined;
                const read_len = c.read(0, &read_buf, read_buf.len);
                if (read_len <= 0) {
                    stdin_open = false;
                    _ = c.kill(-child_pid, c.SIGKILL);
                } else {
                    try stdin_buffer.appendSlice(alloc, read_buf[0..@intCast(read_len)]);
                    while (std.mem.indexOfScalar(u8, stdin_buffer.items, '\n')) |line_end| {
                        const line = try alloc.dupe(u8, stdin_buffer.items[0..line_end]);
                        defer alloc.free(line);
                        const remainder = try alloc.dupe(u8, stdin_buffer.items[line_end + 1 ..]);
                        defer alloc.free(remainder);
                        stdin_buffer.clearRetainingCapacity();
                        try stdin_buffer.appendSlice(alloc, remainder);
                        if (line.len == 0) continue;

                        var parsed = std.json.parseFromSlice(Command, alloc, line, .{
                            .ignore_unknown_fields = true,
                        }) catch continue;
                        defer parsed.deinit();
                        const cmd = parsed.value;

                        if (std.mem.eql(u8, cmd.type, "input")) {
                            const encoded = cmd.data orelse cmd.data_b64 orelse continue;
                            const decoded = decodeInput(alloc, encoded) catch continue;
                            defer alloc.free(decoded);
                            _ = c.write(master_fd, decoded.ptr, decoded.len);
                            try publishBusyState(alloc, stdout_writer, master_fd, child_pid, &last_busy_state, false);
                            continue;
                        }

                        if (std.mem.eql(u8, cmd.type, "flow")) {
                            flow_paused = cmd.paused orelse false;
                            continue;
                        }

                        if (std.mem.eql(u8, cmd.type, "resize")) {
                            const next_cols = cmd.cols orelse startup.cols;
                            const next_rows = cmd.rows orelse startup.rows;
                            applyResize(master_fd, &term, alloc, next_cols, next_rows) catch {};
                            try emitFrame(alloc, stdout_writer, &term, &previous_render_rows, &previous_alt_screen, &has_snapshot, true);
                            continue;
                        }

                        if (std.mem.eql(u8, cmd.type, "snapshot")) {
                            try emitFrame(alloc, stdout_writer, &term, &previous_render_rows, &previous_alt_screen, &has_snapshot, true);
                            continue;
                        }

                        if (std.mem.eql(u8, cmd.type, "cwd")) {
                            try publishCwd(alloc, stdout_writer, child_pid, &last_known_cwd, &last_published_cwd, true);
                            continue;
                        }

                        if (std.mem.eql(u8, cmd.type, "busy")) {
                            try publishBusyState(alloc, stdout_writer, master_fd, child_pid, &last_busy_state, true);
                            continue;
                        }

                        if (std.mem.eql(u8, cmd.type, "kill")) {
                            _ = c.kill(-child_pid, c.SIGKILL);
                            continue;
                        }
                    }
                }
            }
            index += 1;
        }

        if (!flow_paused) {
            const events = pollfds[index].revents;
            if ((events & (c.POLLIN | c.POLLHUP | c.POLLERR)) != 0) {
                var pty_buf: [65536]u8 = undefined;
                const read_len = c.read(master_fd, &pty_buf, pty_buf.len);
                if (read_len > 0) {
                    const bytes = pty_buf[0..@intCast(read_len)];
                    try emitData(alloc, stdout_writer, bytes);
                    try stream.nextSlice(bytes);
                    try emitFrame(alloc, stdout_writer, &term, &previous_render_rows, &previous_alt_screen, &has_snapshot, false);
                    try publishCwd(alloc, stdout_writer, child_pid, &last_known_cwd, &last_published_cwd, false);
                    try publishBusyState(alloc, stdout_writer, master_fd, child_pid, &last_busy_state, false);
                }
            }
        }

        const now_ms = std.time.milliTimestamp();
        if (now_ms - last_busy_poll_ms >= BUSY_POLL_INTERVAL_MS) {
            last_busy_poll_ms = now_ms;
            try publishBusyState(alloc, stdout_writer, master_fd, child_pid, &last_busy_state, false);
        }

        if (reapChild(child_pid)) |exit_code| {
            try emitExit(stdout_writer, exit_code);
            child_done = true;
        }
    }
}
