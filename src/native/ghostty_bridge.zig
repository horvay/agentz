const std = @import("std");
const ghostty_vt = @import("ghostty-vt");

const Command = struct {
    type: []const u8,
    data_b64: ?[]const u8 = null,
    cols: ?u16 = null,
    rows: ?u16 = null,
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
    cols: u16,
    rows: u16,
    alt_screen: bool,
};

const OwnedRows = std.ArrayList([]u8);

fn isAltScreen(term: *ghostty_vt.Terminal) bool {
    return term.modes.get(.alt_screen_save_cursor_clear_enter) or
        term.modes.get(.alt_screen) or
        term.modes.get(.alt_screen_legacy);
}

fn writeModePrefix(
    writer: *std.Io.Writer,
    term: *ghostty_vt.Terminal,
) !void {
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

fn writeScrollingRegion(
    writer: *std.Io.Writer,
    term: *ghostty_vt.Terminal,
) !void {
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

fn writeCursorState(
    writer: *std.Io.Writer,
    term: *ghostty_vt.Terminal,
) !void {
    var formatter: ghostty_vt.formatter.ScreenFormatter = .init(term.screens.active, .{ .emit = .vt });
    formatter.content = .none;
    formatter.extra = .all;
    try formatter.format(writer);
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

fn capturePlainRows(
    alloc: std.mem.Allocator,
    term: *ghostty_vt.Terminal,
) !OwnedRows {
    var rows: OwnedRows = .empty;
    errdefer {
        for (rows.items) |row| alloc.free(row);
        rows.deinit(alloc);
    }

    for (0..@as(usize, @intCast(term.rows))) |row_index| {
        const row = try formatRow(alloc, term, row_index, .plain);
        try rows.append(alloc, row);
    }

    return rows;
}

fn freeOwnedRows(
    alloc: std.mem.Allocator,
    rows: *OwnedRows,
) void {
    for (rows.items) |row| alloc.free(row);
    rows.clearRetainingCapacity();
}

fn replaceOwnedRows(
    alloc: std.mem.Allocator,
    dest: *OwnedRows,
    src: *OwnedRows,
) void {
    freeOwnedRows(alloc, dest);
    dest.* = src.*;
    src.* = .empty;
}

fn joinRows(
    alloc: std.mem.Allocator,
    rows: []const []u8,
) ![]u8 {
    var builder: std.Io.Writer.Allocating = .init(alloc);
    defer builder.deinit();
    for (rows, 0..) |row, idx| {
        if (idx > 0) try builder.writer.writeByte('\n');
        try builder.writer.writeAll(row);
    }
    return try alloc.dupe(u8, builder.writer.buffered());
}

fn buildFullVt(
    alloc: std.mem.Allocator,
    term: *ghostty_vt.Terminal,
    alt_screen: bool,
) ![]u8 {
    if (!alt_screen) {
        return buildPrimaryScreenFullVt(alloc, term);
    }

    var builder: std.Io.Writer.Allocating = .init(alloc);
    defer builder.deinit();

    try writeModePrefix(&builder.writer, term);

    var formatter_state: ghostty_vt.formatter.TerminalFormatter = .init(term, .{ .emit = .vt });
    formatter_state.extra = .{
        .palette = false,
        .modes = alt_screen,
        .scrolling_region = true,
        .tabstops = false,
        .pwd = false,
        .keyboard = false,
        .screen = .all,
    };
    formatter_state.extra.screen.cursor = false;
    try formatter_state.format(&builder.writer);

    var formatter_cursor: ghostty_vt.formatter.TerminalFormatter = .init(term, .{ .emit = .vt });
    formatter_cursor.content = .none;
    formatter_cursor.extra = .none;
    formatter_cursor.extra.screen.cursor = true;
    try formatter_cursor.format(&builder.writer);

    return try alloc.dupe(u8, builder.writer.buffered());
}

fn buildPrimaryScreenFullVt(
    alloc: std.mem.Allocator,
    term: *ghostty_vt.Terminal,
) ![]u8 {
    var builder: std.Io.Writer.Allocating = .init(alloc);
    defer builder.deinit();

    try writeModePrefix(&builder.writer, term);
    try writeScrollingRegion(&builder.writer, term);

    for (0..@as(usize, @intCast(term.rows))) |row_index| {
        try builder.writer.print("\x1b[{d};1H\x1b[2K", .{row_index + 1});
        const row_vt = try formatRow(alloc, term, row_index, .vt);
        defer alloc.free(row_vt);
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
    previous_rows: []const []u8,
    current_rows: []const []u8,
) ![]u8 {
    var builder: std.Io.Writer.Allocating = .init(alloc);
    defer builder.deinit();

    try writeModePrefix(&builder.writer, term);
    try writeScrollingRegion(&builder.writer, term);

    for (current_rows, 0..) |row, row_index| {
        if (std.mem.eql(u8, previous_rows[row_index], row)) continue;

        try builder.writer.print("\x1b[{d};1H\x1b[2K", .{row_index + 1});
        if (row.len == 0) continue;

        const row_vt = try formatRow(alloc, term, row_index, .vt);
        defer alloc.free(row_vt);
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
            .cols = @as(u16, @intCast(term.cols)),
            .rows = @as(u16, @intCast(term.rows)),
            .alt_screen = alt_screen,
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
    previous_rows: *OwnedRows,
    previous_alt_screen: *bool,
    has_snapshot: *bool,
    force_full: bool,
) !void {
    const alt_screen = isAltScreen(term);
    var current_rows = try capturePlainRows(alloc, term);
    defer {
        freeOwnedRows(alloc, &current_rows);
        current_rows.deinit(alloc);
    }

    const plain = try joinRows(alloc, current_rows.items);
    defer alloc.free(plain);

    var mode: FrameMode = .patch;
    var use_full = force_full or
        !has_snapshot.* or
        !alt_screen or
        alt_screen or
        previous_alt_screen.* != alt_screen or
        previous_rows.items.len != current_rows.items.len;

    var dirty_rows: usize = 0;
    var first_dirty_row: ?usize = null;
    var last_dirty_row: ?usize = null;
    if (!use_full) {
        for (current_rows.items, 0..) |row, idx| {
            if (!std.mem.eql(u8, previous_rows.items[idx], row)) {
                dirty_rows += 1;
                if (first_dirty_row == null) first_dirty_row = idx;
                last_dirty_row = idx;
            }
        }

        const cursor_row: usize = @intCast(term.screens.active.cursor.y);

        // Keep patch mode extremely narrow on the primary screen: only allow
        // an in-place edit to the active cursor row. Scrolls near the bottom
        // of the terminal can otherwise look like a tiny contiguous diff even
        // though the visible history shifted.
        const patchable_cursor_row_only = dirty_rows == 1 and
            first_dirty_row != null and
            first_dirty_row.? == cursor_row and
            last_dirty_row != null and
            last_dirty_row.? == cursor_row;

        if (!patchable_cursor_row_only and dirty_rows > 0) {
            use_full = true;
        }
    }

    const vt = if (use_full) blk: {
        mode = .full;
        break :blk try buildFullVt(alloc, term, alt_screen);
    } else blk: {
        mode = .patch;
        break :blk try buildPatchVt(alloc, term, previous_rows.items, current_rows.items);
    };
    defer alloc.free(vt);

    try writeFrame(alloc, stdout_writer, mode, vt, plain, term, alt_screen);
    replaceOwnedRows(alloc, previous_rows, &current_rows);
    previous_alt_screen.* = alt_screen;
    has_snapshot.* = true;
}

pub fn main() !void {
    var gpa: std.heap.DebugAllocator(.{}) = .init;
    defer _ = gpa.deinit();
    const alloc = gpa.allocator();

    var args = try std.process.argsWithAllocator(alloc);
    defer args.deinit();

    _ = args.next();
    const cols_arg = args.next() orelse "120";
    const rows_arg = args.next() orelse "36";
    const init_cols = std.fmt.parseInt(u16, cols_arg, 10) catch 120;
    const init_rows = std.fmt.parseInt(u16, rows_arg, 10) catch 36;

    var term: ghostty_vt.Terminal = try .init(alloc, .{
        .cols = init_cols,
        .rows = init_rows,
    });
    defer term.deinit(alloc);

    var stream = term.vtStream();
    defer stream.deinit();

    var previous_rows: OwnedRows = .empty;
    defer {
        freeOwnedRows(alloc, &previous_rows);
        previous_rows.deinit(alloc);
    }
    var previous_alt_screen = false;
    var has_snapshot = false;

    var stdin_file = std.fs.File.stdin();
    var stdout_file = std.fs.File.stdout();
    var stdout_buf: [4096]u8 = undefined;
    var stdout_writer_state = stdout_file.writer(&stdout_buf);
    var stdin_reader = stdin_file.deprecatedReader();
    const stdout_writer = &stdout_writer_state.interface;

    while (try stdin_reader.readUntilDelimiterOrEofAlloc(alloc, '\n', 8 * 1024 * 1024)) |line| {
        defer alloc.free(line);
        if (line.len == 0) continue;

        var parsed = std.json.parseFromSlice(Command, alloc, line, .{
            .ignore_unknown_fields = true,
        }) catch continue;
        defer parsed.deinit();
        const cmd = parsed.value;

        if (std.mem.eql(u8, cmd.type, "feed")) {
            const encoded = cmd.data_b64 orelse continue;
            const decoded_len = std.base64.standard.Decoder.calcSizeForSlice(encoded) catch continue;
            const decoded = try alloc.alloc(u8, decoded_len);
            defer alloc.free(decoded);
            _ = std.base64.standard.Decoder.decode(decoded, encoded) catch continue;
            try stream.nextSlice(decoded);
            try emitFrame(alloc, stdout_writer, &term, &previous_rows, &previous_alt_screen, &has_snapshot, false);
            continue;
        }

        if (std.mem.eql(u8, cmd.type, "resize")) {
            const next_cols = cmd.cols orelse init_cols;
            const next_rows = cmd.rows orelse init_rows;
            try term.resize(alloc, next_cols, next_rows);
            try emitFrame(alloc, stdout_writer, &term, &previous_rows, &previous_alt_screen, &has_snapshot, true);
            continue;
        }

        if (std.mem.eql(u8, cmd.type, "snapshot")) {
            try emitFrame(alloc, stdout_writer, &term, &previous_rows, &previous_alt_screen, &has_snapshot, true);
            continue;
        }
    }
}
