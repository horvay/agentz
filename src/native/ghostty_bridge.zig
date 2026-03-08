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

fn captureRows(
    alloc: std.mem.Allocator,
    term: *ghostty_vt.Terminal,
    emit: ghostty_vt.formatter.Format,
) !OwnedRows {
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
    current_render_rows: []const []u8,
) ![]u8 {
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
    var current_plain_rows = try captureRows(alloc, term, .plain);
    defer {
        freeOwnedRows(alloc, &current_plain_rows);
        current_plain_rows.deinit(alloc);
    }

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

        // Keep patch mode conservative.
        // - On the primary screen, only allow a cursor-only change or an
        //   in-place edit to the active cursor row. Scrolls near the bottom
        //   of the terminal can otherwise look like a tiny contiguous diff even
        //   though the visible history shifted.
        // - On the alternate screen, allow cursor-only changes and very small
        //   contiguous row updates. Neovim cursor motion commonly repaints the
        //   old and new cursor rows; treating that as a patch avoids queuing a
        //   full-screen snapshot for every repeated j/k move.
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

    const plain = if (patch_kind != null and std.mem.eql(u8, patch_kind.?, "cursor-only"))
        try alloc.dupe(u8, "")
    else
        try joinRows(alloc, current_plain_rows.items);
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

    var previous_render_rows: OwnedRows = .empty;
    defer {
        freeOwnedRows(alloc, &previous_render_rows);
        previous_render_rows.deinit(alloc);
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
            try emitFrame(alloc, stdout_writer, &term, &previous_render_rows, &previous_alt_screen, &has_snapshot, false);
            continue;
        }

        if (std.mem.eql(u8, cmd.type, "resize")) {
            const next_cols = cmd.cols orelse init_cols;
            const next_rows = cmd.rows orelse init_rows;
            try term.resize(alloc, next_cols, next_rows);
            try emitFrame(alloc, stdout_writer, &term, &previous_render_rows, &previous_alt_screen, &has_snapshot, true);
            continue;
        }

        if (std.mem.eql(u8, cmd.type, "snapshot")) {
            try emitFrame(alloc, stdout_writer, &term, &previous_render_rows, &previous_alt_screen, &has_snapshot, true);
            continue;
        }
    }
}
