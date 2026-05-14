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
    pixel_width: ?u16 = null,
    pixel_height: ?u16 = null,
    paused: ?bool = null,
    interval_ms: ?u16 = null,
    preview_only: ?bool = null,
    encoding: ?[]const u8 = null,
};

const FrameMode = enum {
    full,
    patch,
};

const HostPacketType = enum(u8) {
    frame = 1,
    exit = 2,
    cwd = 3,
    busy = 4,
};

const OwnedRows = std.ArrayList([]u8);
const KITTY_GRAPHICS_PLACEHOLDER: u21 = 0x10EEEE;
const ImageVersionMap = std.AutoHashMap(u32, std.time.Instant);
const ScreenRowPayload = struct {
    index: u16,
    text: []const u8,
};
const ImagePayload = struct {
    id: u32,
    width: u16,
    height: u16,
    format: u8,
    data: []const u8,
};
const ImagePlacementPayload = struct {
    image_id: u32,
    screen_x: u16,
    screen_y: u32,
    z: i32,
    cell_offset_x: u16,
    cell_offset_y: u16,
    source_x: u16,
    source_y: u16,
    source_width: u16,
    source_height: u16,
    columns: u16,
    rows: u16,
    pixel_width: u16 = 0,
    pixel_height: u16 = 0,
};

const HostStreamHandler = struct {
    alloc: std.mem.Allocator,
    terminal: *ghostty_vt.Terminal,
    apc: ghostty_vt.apc.Handler = .{},

    pub fn init(alloc: std.mem.Allocator, terminal: *ghostty_vt.Terminal) HostStreamHandler {
        return .{
            .alloc = alloc,
            .terminal = terminal,
        };
    }

    pub fn deinit(self: *HostStreamHandler) void {
        self.apc.deinit();
    }

    pub fn vt(self: *HostStreamHandler, comptime action: ghostty_vt.StreamAction.Tag, value: ghostty_vt.StreamAction.Value(action)) anyerror!void {
        switch (action) {
            .apc_start => self.apc.start(),
            .apc_put => {
                const result = self.apc.feed(self.alloc, value);
                switch (@typeInfo(@TypeOf(result))) {
                    .error_union => try result,
                    .void => {},
                    else => @compileError("unexpected APC feed return type"),
                }
            },
            .apc_end => {
                var cmd = self.apc.end() orelse return;
                defer cmd.deinit(self.alloc);
                switch (cmd) {
                    .kitty => |*kitty_cmd| {
                        if (@hasDecl(ghostty_vt.kitty.graphics, "Command")) {
                            _ = self.terminal.kittyGraphics(self.alloc, kitty_cmd);
                        }
                    },
                }
            },
            else => {
                var readonly = self.terminal.vtHandler();
                const result = readonly.vt(action, value);
                switch (@typeInfo(@TypeOf(result))) {
                    .error_union => try result,
                    .void => {},
                    else => @compileError("unexpected vt handler return type"),
                }
            },
        }
    }
};

fn nextSliceCompat(stream: anytype, input: []const u8) !void {
    const result = stream.nextSlice(input);
    switch (@typeInfo(@TypeOf(result))) {
        .error_union => try result,
        .void => {},
        else => @compileError("unexpected nextSlice return type"),
    }
}

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

fn hasVirtualKittyPlacements(term: *ghostty_vt.Terminal) bool {
    if (!@hasField(@TypeOf(term.screens.active.kitty_images), "placements")) return false;

    var it = term.screens.active.kitty_images.placements.iterator();
    while (it.next()) |entry| {
        switch (entry.value_ptr.location) {
            .virtual => return true,
            .pin => {},
        }
    }
    return false;
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
}

fn sanitizeTerminalRow(alloc: std.mem.Allocator, row: []const u8) ![]u8 {
    if (std.mem.indexOfScalar(u8, row, 0xF4) == null) return try alloc.dupe(u8, row);

    var iter: std.unicode.Utf8Iterator = .{ .bytes = row, .i = 0 };
    var builder: std.ArrayList(u8) = .empty;
    defer builder.deinit(alloc);
    var changed = false;
    var saw_placeholder = false;

    while (iter.nextCodepointSlice()) |slice| {
        const cp = std.unicode.utf8Decode(slice) catch {
            try builder.appendSlice(alloc, slice);
            continue;
        };
        if (cp == KITTY_GRAPHICS_PLACEHOLDER) {
            try builder.append(alloc, ' ');
            changed = true;
            saw_placeholder = true;
            continue;
        }
        if (saw_placeholder and cp >= 0x0300 and cp <= 0x036F) {
            changed = true;
            continue;
        }
        try builder.appendSlice(alloc, slice);
    }

    if (!changed) return try alloc.dupe(u8, row);
    return try alloc.dupe(u8, builder.items);
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
    return try sanitizeTerminalRow(alloc, builder.writer.buffered());
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

fn buildFullVt(alloc: std.mem.Allocator, term: *ghostty_vt.Terminal, render_rows: []const []u8) ![]u8 {
    var builder: std.Io.Writer.Allocating = .init(alloc);
    defer builder.deinit();

    try writeModePrefix(&builder.writer, term);
    try writeScrollingRegion(&builder.writer, term);

    for (render_rows, 0..) |row_vt, row_index| {
        try builder.writer.print("\x1b[{d};1H\x1b[0m\x1b[2K", .{row_index + 1});
        if (row_vt.len == 0) continue;
        try builder.writer.writeAll(row_vt);
    }

    try writeCursorState(&builder.writer, term);
    return try alloc.dupe(u8, builder.writer.buffered());
}

fn buildFullScrollbackVt(alloc: std.mem.Allocator, term: *ghostty_vt.Terminal) ![]u8 {
    var builder: std.Io.Writer.Allocating = .init(alloc);
    defer builder.deinit();

    try writeModePrefix(&builder.writer, term);
    try writeScrollingRegion(&builder.writer, term);

    var formatter: ghostty_vt.formatter.PageListFormatter = .init(&term.screens.active.pages, .vt);
    try formatter.format(&builder.writer);

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

        // Each row formatter starts from default attrs, so reset before clearing/repainting.
        try builder.writer.print("\x1b[{d};1H\x1b[0m\x1b[2K", .{row_index + 1});
        if (row_vt.len == 0) continue;
        try builder.writer.writeAll(row_vt);
    }

    try writeCursorState(&builder.writer, term);
    return try alloc.dupe(u8, builder.writer.buffered());
}

fn appendU16(buffer: *std.ArrayList(u8), alloc: std.mem.Allocator, value: u16) !void {
    try buffer.append(alloc, @intCast(value & 0xff));
    try buffer.append(alloc, @intCast((value >> 8) & 0xff));
}

fn appendU32(buffer: *std.ArrayList(u8), alloc: std.mem.Allocator, value: u32) !void {
    try buffer.append(alloc, @intCast(value & 0xff));
    try buffer.append(alloc, @intCast((value >> 8) & 0xff));
    try buffer.append(alloc, @intCast((value >> 16) & 0xff));
    try buffer.append(alloc, @intCast((value >> 24) & 0xff));
}

fn appendI32(buffer: *std.ArrayList(u8), alloc: std.mem.Allocator, value: i32) !void {
    try appendU32(buffer, alloc, @bitCast(value));
}

fn appendU64(buffer: *std.ArrayList(u8), alloc: std.mem.Allocator, value: u64) !void {
    try buffer.append(alloc, @intCast(value & 0xff));
    try buffer.append(alloc, @intCast((value >> 8) & 0xff));
    try buffer.append(alloc, @intCast((value >> 16) & 0xff));
    try buffer.append(alloc, @intCast((value >> 24) & 0xff));
    try buffer.append(alloc, @intCast((value >> 32) & 0xff));
    try buffer.append(alloc, @intCast((value >> 40) & 0xff));
    try buffer.append(alloc, @intCast((value >> 48) & 0xff));
    try buffer.append(alloc, @intCast((value >> 56) & 0xff));
}

fn appendI64(buffer: *std.ArrayList(u8), alloc: std.mem.Allocator, value: i64) !void {
    try appendU64(buffer, alloc, @bitCast(value));
}

fn imageFormatByte(format: anytype) u8 {
    return switch (format) {
        .gray => 0,
        .gray_alpha => 1,
        .rgb => 2,
        .rgba => 3,
        .png => unreachable,
    };
}

fn appendKittyImageScene(
    alloc: std.mem.Allocator,
    term: *ghostty_vt.Terminal,
    pixel_width: u16,
    pixel_height: u16,
    force_full: bool,
    previous_versions: *ImageVersionMap,
    image_payloads: *std.ArrayList(ImagePayload),
    image_removed_ids: *std.ArrayList(u32),
    image_placements: *std.ArrayList(ImagePlacementPayload),
) !void {
    if (!@hasField(@TypeOf(term.screens.active.kitty_images), "placements")) return;

    var current_versions = ImageVersionMap.init(alloc);
    defer current_versions.deinit();

    const storage = &term.screens.active.kitty_images;
    var has_virtual = false;
    var placement_it = storage.placements.iterator();
    while (placement_it.next()) |entry| {
        const placement = entry.value_ptr;
        switch (placement.location) {
            .pin => |pin| {
                const image = storage.imageById(entry.key_ptr.image_id) orelse continue;
                const point = term.screens.active.pages.pointFromPin(.screen, pin.*) orelse continue;

                const source_x: u32 = @min(image.width, placement.source_x);
                const source_y: u32 = @min(image.height, placement.source_y);
                const source_width: u32 = if (placement.source_width > 0)
                    @min(image.width - source_x, placement.source_width)
                else
                    image.width;
                const source_height: u32 = if (placement.source_height > 0)
                    @min(image.height - source_y, placement.source_height)
                else
                    image.height;

                try image_placements.append(alloc, .{
                    .image_id = entry.key_ptr.image_id,
                    .screen_x = @intCast(point.screen.x),
                    .screen_y = point.screen.y,
                    .z = placement.z,
                    .cell_offset_x = @intCast(placement.x_offset),
                    .cell_offset_y = @intCast(placement.y_offset),
                    .source_x = @intCast(source_x),
                    .source_y = @intCast(source_y),
                    .source_width = @intCast(source_width),
                    .source_height = @intCast(source_height),
                    .columns = @intCast(placement.columns),
                    .rows = @intCast(placement.rows),
                });

                if (!current_versions.contains(image.id)) {
                    try current_versions.put(image.id, image.transmit_time);
                    const previous = previous_versions.get(image.id);
                    if (force_full or previous == null or previous.?.order(image.transmit_time) != .eq) {
                        try image_payloads.append(alloc, .{
                            .id = image.id,
                            .width = @intCast(image.width),
                            .height = @intCast(image.height),
                            .format = imageFormatByte(image.format),
                            .data = image.data,
                        });
                    }
                }
            },
            .virtual => {
                has_virtual = true;
            },
        }
    }

    if (has_virtual and term.cols > 0 and term.rows > 0 and pixel_width > 0 and pixel_height > 0) {
        if (@hasDecl(ghostty_vt.kitty.graphics, "unicode")) {
            const cell_width: u32 = @max(1, @as(u32, pixel_width) / @as(u32, @intCast(term.cols)));
            const cell_height: u32 = @max(1, @as(u32, pixel_height) / @as(u32, @intCast(term.rows)));
            const top = term.screens.active.pages.getTopLeft(.viewport);
            const bot = term.screens.active.pages.getBottomRight(.viewport) orelse top;
            var virtual_it = ghostty_vt.kitty.graphics.unicode.placementIterator(top, bot);
            while (virtual_it.next()) |virtual_p| {
                const image = storage.imageById(virtual_p.image_id) orelse continue;
                const render_p = virtual_p.renderPlacement(storage, &image, cell_width, cell_height) catch continue;
                if (render_p.dest_width == 0 or render_p.dest_height == 0) continue;
                const point = term.screens.active.pages.pointFromPin(.screen, render_p.top_left) orelse continue;
                try image_placements.append(alloc, .{
                    .image_id = virtual_p.image_id,
                    .screen_x = @intCast(point.screen.x),
                    .screen_y = point.screen.y,
                    .z = -1,
                    .cell_offset_x = @intCast(render_p.offset_x),
                    .cell_offset_y = @intCast(render_p.offset_y),
                    .source_x = @intCast(render_p.source_x),
                    .source_y = @intCast(render_p.source_y),
                    .source_width = @intCast(render_p.source_width),
                    .source_height = @intCast(render_p.source_height),
                    .columns = @intCast(virtual_p.width),
                    .rows = @intCast(virtual_p.height),
                    .pixel_width = @intCast(render_p.dest_width),
                    .pixel_height = @intCast(render_p.dest_height),
                });

                if (!current_versions.contains(image.id)) {
                    try current_versions.put(image.id, image.transmit_time);
                    const previous = previous_versions.get(image.id);
                    if (force_full or previous == null or previous.?.order(image.transmit_time) != .eq) {
                        try image_payloads.append(alloc, .{
                            .id = image.id,
                            .width = @intCast(image.width),
                            .height = @intCast(image.height),
                            .format = imageFormatByte(image.format),
                            .data = image.data,
                        });
                    }
                }
            }
        }
    }

    var previous_it = previous_versions.iterator();
    while (previous_it.next()) |entry| {
        if (!current_versions.contains(entry.key_ptr.*)) {
            try image_removed_ids.append(alloc, entry.key_ptr.*);
        }
    }

    previous_versions.clearRetainingCapacity();
    var current_it = current_versions.iterator();
    while (current_it.next()) |entry| {
        try previous_versions.put(entry.key_ptr.*, entry.value_ptr.*);
    }
}

fn writePacket(stdout_writer: *std.Io.Writer, kind: HostPacketType, payload: []const u8) !void {
    var header: [5]u8 = .{
        @intFromEnum(kind),
        0,
        0,
        0,
        0,
    };
    const payload_len: u32 = @intCast(payload.len);
    header[1] = @intCast(payload_len & 0xff);
    header[2] = @intCast((payload_len >> 8) & 0xff);
    header[3] = @intCast((payload_len >> 16) & 0xff);
    header[4] = @intCast((payload_len >> 24) & 0xff);
    try stdout_writer.writeAll(&header);
    try stdout_writer.writeAll(payload);
}

fn writeFrame(
    alloc: std.mem.Allocator,
    stdout_writer: *std.Io.Writer,
    mode: FrameMode,
    vt: []const u8,
    plain: []const u8,
    screen_rows: []const ScreenRowPayload,
    image_payloads: []const ImagePayload,
    image_removed_ids: []const u32,
    image_placements: []const ImagePlacementPayload,
    patch_kind: ?[]const u8,
    term: *ghostty_vt.Terminal,
    alt_screen: bool,
) !void {
    var payload: std.ArrayList(u8) = .empty;
    defer payload.deinit(alloc);

    var flags: u8 = 0;
    if (alt_screen) flags |= 1;
    if (term.modes.get(.cursor_visible)) flags |= 1 << 1;
    if (term.modes.get(.cursor_blinking)) flags |= 1 << 2;
    if (term.modes.get(.focus_event)) flags |= 1 << 3;
    if (term.modes.get(.mouse_alternate_scroll)) flags |= 1 << 4;
    if (term.modes.get(.bracketed_paste)) flags |= 1 << 5;

    const cursor_style: u8 = switch (term.screens.active.cursor.cursor_style) {
        .block, .block_hollow => 0,
        .underline => 1,
        .bar => 2,
    };
    const patch_kind_byte: u8 = if (patch_kind == null)
        0
    else if (std.mem.eql(u8, patch_kind.?, "cursor-only"))
        1
    else if (std.mem.eql(u8, patch_kind.?, "row-update"))
        2
    else
        3;
    const mouse_tracking_mode: u8 = switch (term.flags.mouse_event) {
        .none => 0,
        .x10 => 1,
        .normal => 2,
        .button => 3,
        .any => 4,
    };
    const mouse_format: u8 = switch (term.flags.mouse_format) {
        .x10 => 0,
        .utf8 => 1,
        .sgr => 2,
        .urxvt => 3,
        .sgr_pixels => 4,
    };

    try payload.append(alloc, if (mode == .full) 0 else 1);
    try payload.append(alloc, flags);
    try payload.append(alloc, cursor_style);
    try payload.append(alloc, patch_kind_byte);
    try payload.append(alloc, mouse_tracking_mode);
    try payload.append(alloc, mouse_format);
    try appendU16(&payload, alloc, @as(u16, @intCast(term.cols)));
    try appendU16(&payload, alloc, @as(u16, @intCast(term.rows)));
    try appendU16(&payload, alloc, @as(u16, @intCast(term.screens.active.cursor.y)) + 1);
    try appendU16(&payload, alloc, @as(u16, @intCast(term.screens.active.cursor.x)) + 1);
    try appendU32(&payload, alloc, @intCast(vt.len));
    try appendU32(&payload, alloc, @intCast(plain.len));
    try payload.appendSlice(alloc, vt);
    try payload.appendSlice(alloc, plain);
    try appendU16(&payload, alloc, @intCast(screen_rows.len));
    for (screen_rows) |row| {
        try appendU16(&payload, alloc, row.index);
        try appendU32(&payload, alloc, @intCast(row.text.len));
        try payload.appendSlice(alloc, row.text);
    }
    try appendU16(&payload, alloc, @intCast(image_payloads.len));
    for (image_payloads) |image| {
        try appendU32(&payload, alloc, image.id);
        try appendU16(&payload, alloc, image.width);
        try appendU16(&payload, alloc, image.height);
        try payload.append(alloc, image.format);
        try appendU32(&payload, alloc, @intCast(image.data.len));
        try payload.appendSlice(alloc, image.data);
    }
    try appendU16(&payload, alloc, @intCast(image_removed_ids.len));
    for (image_removed_ids) |image_id| {
        try appendU32(&payload, alloc, image_id);
    }
    try appendU16(&payload, alloc, @intCast(image_placements.len));
    for (image_placements) |placement| {
        try appendU32(&payload, alloc, placement.image_id);
        try appendU16(&payload, alloc, placement.screen_x);
        try appendU32(&payload, alloc, placement.screen_y);
        try appendI32(&payload, alloc, placement.z);
        try appendU16(&payload, alloc, placement.cell_offset_x);
        try appendU16(&payload, alloc, placement.cell_offset_y);
        try appendU16(&payload, alloc, placement.source_x);
        try appendU16(&payload, alloc, placement.source_y);
        try appendU16(&payload, alloc, placement.source_width);
        try appendU16(&payload, alloc, placement.source_height);
        try appendU16(&payload, alloc, placement.columns);
        try appendU16(&payload, alloc, placement.rows);
        try appendU16(&payload, alloc, placement.pixel_width);
        try appendU16(&payload, alloc, placement.pixel_height);
    }
    try writePacket(stdout_writer, .frame, payload.items);
}

fn emitFrame(
    alloc: std.mem.Allocator,
    stdout_writer: *std.Io.Writer,
    term: *ghostty_vt.Terminal,
    previous_render_rows: *OwnedRows,
    previous_alt_screen: *bool,
    previous_image_versions: *ImageVersionMap,
    pixel_width: u16,
    pixel_height: u16,
    pending_vt_bytes: *std.ArrayList(u8),
    has_snapshot: *bool,
    force_full: bool,
    include_scrollback: bool,
    preview_only: bool,
) !void {
    const alt_screen = isAltScreen(term);
    if (preview_only) {
        var current_plain_rows = try captureRows(alloc, term, .plain);
        defer {
            freeOwnedRows(alloc, &current_plain_rows);
            current_plain_rows.deinit(alloc);
        }

        const plain = try joinRows(alloc, current_plain_rows.items);
        defer alloc.free(plain);

        var screen_rows: std.ArrayList(ScreenRowPayload) = .empty;
        defer screen_rows.deinit(alloc);
        for (current_plain_rows.items, 0..) |row, idx| {
            try screen_rows.append(alloc, .{ .index = @intCast(idx), .text = row });
        }

        const no_images = [_]ImagePayload{};
        const no_removed = [_]u32{};
        const no_placements = [_]ImagePlacementPayload{};
        try writeFrame(
            alloc,
            stdout_writer,
            .full,
            "",
            plain,
            screen_rows.items,
            &no_images,
            &no_removed,
            &no_placements,
            null,
            term,
            alt_screen,
        );
        previous_image_versions.clearRetainingCapacity();
        previous_alt_screen.* = alt_screen;
        pending_vt_bytes.clearRetainingCapacity();
        has_snapshot.* = true;
        return;
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

        if (alt_screen and dirty_rows > 0) {
            use_full = true;
        } else if (pending_vt_bytes.items.len == 0 and dirty_rows > 4) {
            use_full = true;
        }
    }

    const has_virtual_kitty = hasVirtualKittyPlacements(term);
    if (use_full and previous_alt_screen.* and !alt_screen and pending_vt_bytes.items.len > 0 and !has_virtual_kitty) {
        use_full = false;
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

    var screen_rows: std.ArrayList(ScreenRowPayload) = .empty;
    defer screen_rows.deinit(alloc);
    if (include_plain) {
        if (use_full) {
            for (current_render_rows.items, 0..) |row, idx| {
                try screen_rows.append(alloc, .{ .index = @intCast(idx), .text = row });
            }
        } else {
            for (current_render_rows.items, 0..) |row_vt, idx| {
                if (std.mem.eql(u8, previous_render_rows.items[idx], row_vt)) continue;
                try screen_rows.append(alloc, .{ .index = @intCast(idx), .text = row_vt });
            }
        }
    }

    const vt = if (use_full) blk: {
        mode = .full;
        if (include_scrollback and !alt_screen and !has_virtual_kitty) {
            break :blk try buildFullScrollbackVt(alloc, term);
        }
        break :blk try buildFullVt(alloc, term, current_render_rows.items);
    } else blk: {
        mode = .patch;
        if (!alt_screen and pending_vt_bytes.items.len > 0 and !has_virtual_kitty) {
            break :blk try alloc.dupe(u8, pending_vt_bytes.items);
        }
        break :blk try buildPatchVt(alloc, term, previous_render_rows.items, current_render_rows.items);
    };
    defer alloc.free(vt);

    var image_payloads: std.ArrayList(ImagePayload) = .empty;
    defer image_payloads.deinit(alloc);
    var image_removed_ids: std.ArrayList(u32) = .empty;
    defer image_removed_ids.deinit(alloc);
    var image_placements: std.ArrayList(ImagePlacementPayload) = .empty;
    defer image_placements.deinit(alloc);
    try appendKittyImageScene(
        alloc,
        term,
        pixel_width,
        pixel_height,
        mode == .full,
        previous_image_versions,
        &image_payloads,
        &image_removed_ids,
        &image_placements,
    );

    try writeFrame(
        alloc,
        stdout_writer,
        mode,
        vt,
        plain,
        screen_rows.items,
        image_payloads.items,
        image_removed_ids.items,
        image_placements.items,
        patch_kind,
        term,
        alt_screen,
    );
    replaceOwnedRows(alloc, previous_render_rows, &current_render_rows);
    previous_alt_screen.* = alt_screen;
    pending_vt_bytes.clearRetainingCapacity();
    has_snapshot.* = true;
}

fn maybeEmitPendingFrame(
    alloc: std.mem.Allocator,
    stdout_writer: *std.Io.Writer,
    term: *ghostty_vt.Terminal,
    previous_render_rows: *OwnedRows,
    previous_alt_screen: *bool,
    previous_image_versions: *ImageVersionMap,
    pixel_width: u16,
    pixel_height: u16,
    pending_vt_bytes: *std.ArrayList(u8),
    has_snapshot: *bool,
    pending_frame: *bool,
    frame_interval_ms: i64,
    last_frame_emit_ms: *i64,
    force_full: bool,
    preview_only: bool,
) !bool {
    if (!pending_frame.* and !force_full) return false;

    const now_ms = std.time.milliTimestamp();
    if (!force_full and frame_interval_ms > 0 and now_ms - last_frame_emit_ms.* < frame_interval_ms) {
        return false;
    }

    try emitFrame(
        alloc,
        stdout_writer,
        term,
        previous_render_rows,
        previous_alt_screen,
        previous_image_versions,
        pixel_width,
        pixel_height,
        pending_vt_bytes,
        has_snapshot,
        force_full,
        false,
        preview_only,
    );
    pending_frame.* = false;
    last_frame_emit_ms.* = now_ms;
    return true;
}

fn emitExit(stdout_writer: *std.Io.Writer, code: i32) !void {
    const raw: u32 = @bitCast(code);
    const payload: [4]u8 = .{
        @intCast(raw & 0xff),
        @intCast((raw >> 8) & 0xff),
        @intCast((raw >> 16) & 0xff),
        @intCast((raw >> 24) & 0xff),
    };
    try writePacket(stdout_writer, .exit, payload[0..]);
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
    var payload: std.ArrayList(u8) = .empty;
    defer payload.deinit(alloc);
    try appendU32(&payload, alloc, @intCast(next.len));
    try payload.appendSlice(alloc, next);
    try writePacket(stdout_writer, .cwd, payload.items);
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
    var payload: std.ArrayList(u8) = .empty;
    defer payload.deinit(alloc);
    try payload.append(alloc, if (next_busy) 1 else 0);
    try appendI64(&payload, alloc, std.time.milliTimestamp());
    try writePacket(stdout_writer, .busy, payload.items);
}

fn decodeInput(alloc: std.mem.Allocator, encoded: []const u8) ![]u8 {
    const decoded_len = try std.base64.standard.Decoder.calcSizeForSlice(encoded);
    const decoded = try alloc.alloc(u8, decoded_len);
    errdefer alloc.free(decoded);
    _ = try std.base64.standard.Decoder.decode(decoded, encoded);
    return decoded;
}

fn applyResize(
    master_fd: c_int,
    term: *ghostty_vt.Terminal,
    alloc: std.mem.Allocator,
    cols: u16,
    rows: u16,
    pixel_width: u16,
    pixel_height: u16,
) !void {
    var winsize = c.struct_winsize{
        .ws_row = rows,
        .ws_col = cols,
        .ws_xpixel = pixel_width,
        .ws_ypixel = pixel_height,
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

    var stream: ghostty_vt.Stream(HostStreamHandler) = .init(HostStreamHandler.init(alloc, &term));
    defer stream.deinit();

    var previous_render_rows: OwnedRows = .empty;
    defer {
        freeOwnedRows(alloc, &previous_render_rows);
        previous_render_rows.deinit(alloc);
    }
    var previous_alt_screen = false;
    var previous_image_versions = ImageVersionMap.init(alloc);
    defer previous_image_versions.deinit();
    var pending_vt_bytes = std.ArrayList(u8).empty;
    defer pending_vt_bytes.deinit(alloc);
    var has_snapshot = false;

    var stdout_file = std.fs.File.stdout();
    var stdout_buf: [4096]u8 = undefined;
    var stdout_writer_state = stdout_file.writer(&stdout_buf);
    const stdout_writer = &stdout_writer_state.interface;

    const cwd_z = try alloc.dupeZ(u8, startup.cwd);
    defer alloc.free(cwd_z);
    var exec_spec = try ExecSpec.init(alloc, startup);
    defer exec_spec.deinit(alloc);

    var current_pixel_width: u16 = 0;
    var current_pixel_height: u16 = 0;
    var winsize = c.struct_winsize{
        .ws_row = startup.rows,
        .ws_col = startup.cols,
        .ws_xpixel = current_pixel_width,
        .ws_ypixel = current_pixel_height,
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
    var frame_interval_ms: i64 = 0;
    var last_frame_emit_ms = std.time.milliTimestamp();
    var pending_frame = false;
    var preview_only = false;
    var stdin_open = true;
    var child_done = false;

    try emitFrame(
        alloc,
        stdout_writer,
        &term,
        &previous_render_rows,
        &previous_alt_screen,
        &previous_image_versions,
        current_pixel_width,
        current_pixel_height,
        &pending_vt_bytes,
        &has_snapshot,
        true,
        true,
        preview_only,
    );
    last_frame_emit_ms = std.time.milliTimestamp();
    try publishBusyState(alloc, stdout_writer, master_fd, child_pid, &last_busy_state, true);
    try publishCwd(alloc, stdout_writer, child_pid, &last_known_cwd, &last_published_cwd, true);
    try stdout_writer.flush();

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

        var poll_timeout_ms: i32 = 100;
        if (!flow_paused and pending_frame and frame_interval_ms > 0) {
            const now_ms = std.time.milliTimestamp();
            const remaining_ms = frame_interval_ms - (now_ms - last_frame_emit_ms);
            if (remaining_ms <= 0) {
                poll_timeout_ms = 0;
            } else if (remaining_ms < poll_timeout_ms) {
                poll_timeout_ms = @intCast(remaining_ms);
            }
        }

        const poll_rc = c.poll(&pollfds, @intCast(poll_count), poll_timeout_ms);
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
                            try stdout_writer.flush();
                            continue;
                        }

                        if (std.mem.eql(u8, cmd.type, "flow")) {
                            flow_paused = cmd.paused orelse false;
                            continue;
                        }

                        if (std.mem.eql(u8, cmd.type, "frame-rate")) {
                            frame_interval_ms = @intCast(cmd.interval_ms orelse 0);
                            const next_preview_only = cmd.preview_only orelse false;
                            if (next_preview_only != preview_only) {
                                preview_only = next_preview_only;
                                freeOwnedRows(alloc, &previous_render_rows);
                                previous_image_versions.clearRetainingCapacity();
                                pending_vt_bytes.clearRetainingCapacity();
                                has_snapshot = false;
                            }
                            if (!flow_paused) {
                                _ = try maybeEmitPendingFrame(
                                    alloc,
                                    stdout_writer,
                                    &term,
                                    &previous_render_rows,
                                    &previous_alt_screen,
                                    &previous_image_versions,
                                    current_pixel_width,
                                    current_pixel_height,
                                    &pending_vt_bytes,
                                    &has_snapshot,
                                    &pending_frame,
                                    frame_interval_ms,
                                    &last_frame_emit_ms,
                                    false,
                                    preview_only,
                                );
                            }
                            try stdout_writer.flush();
                            continue;
                        }

                        if (std.mem.eql(u8, cmd.type, "resize")) {
                            const next_cols = cmd.cols orelse startup.cols;
                            const next_rows = cmd.rows orelse startup.rows;
                            current_pixel_width = cmd.pixel_width orelse current_pixel_width;
                            current_pixel_height = cmd.pixel_height orelse current_pixel_height;
                            applyResize(master_fd, &term, alloc, next_cols, next_rows, current_pixel_width, current_pixel_height) catch {};
                            freeOwnedRows(alloc, &previous_render_rows);
                            previous_image_versions.clearRetainingCapacity();
                            pending_vt_bytes.clearRetainingCapacity();
                            has_snapshot = false;
                            pending_frame = false;
                            try stdout_writer.flush();
                            continue;
                        }

                        if (std.mem.eql(u8, cmd.type, "snapshot")) {
                            try emitFrame(
                                alloc,
                                stdout_writer,
                                &term,
                                &previous_render_rows,
                                &previous_alt_screen,
                                &previous_image_versions,
                                current_pixel_width,
                                current_pixel_height,
                                &pending_vt_bytes,
                                &has_snapshot,
                                true,
                                true,
                                false,
                            );
                            pending_frame = false;
                            last_frame_emit_ms = std.time.milliTimestamp();
                            try stdout_writer.flush();
                            continue;
                        }

                        if (std.mem.eql(u8, cmd.type, "cwd")) {
                            try publishCwd(alloc, stdout_writer, child_pid, &last_known_cwd, &last_published_cwd, true);
                            try stdout_writer.flush();
                            continue;
                        }

                        if (std.mem.eql(u8, cmd.type, "busy")) {
                            try publishBusyState(alloc, stdout_writer, master_fd, child_pid, &last_busy_state, true);
                            try stdout_writer.flush();
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
                    try nextSliceCompat(&stream, bytes);
                    try pending_vt_bytes.appendSlice(alloc, bytes);
                    pending_frame = true;
                    if (try maybeEmitPendingFrame(
                        alloc,
                        stdout_writer,
                        &term,
                        &previous_render_rows,
                        &previous_alt_screen,
                        &previous_image_versions,
                        current_pixel_width,
                        current_pixel_height,
                        &pending_vt_bytes,
                        &has_snapshot,
                        &pending_frame,
                        frame_interval_ms,
                        &last_frame_emit_ms,
                        false,
                        preview_only,
                    )) {
                        try publishCwd(alloc, stdout_writer, child_pid, &last_known_cwd, &last_published_cwd, false);
                        try publishBusyState(alloc, stdout_writer, master_fd, child_pid, &last_busy_state, false);
                    }
                    try stdout_writer.flush();
                }
            }
        }

        if (!flow_paused and try maybeEmitPendingFrame(
            alloc,
            stdout_writer,
            &term,
            &previous_render_rows,
            &previous_alt_screen,
            &previous_image_versions,
            current_pixel_width,
            current_pixel_height,
            &pending_vt_bytes,
            &has_snapshot,
            &pending_frame,
            frame_interval_ms,
            &last_frame_emit_ms,
            false,
            preview_only,
        )) {
            try publishCwd(alloc, stdout_writer, child_pid, &last_known_cwd, &last_published_cwd, false);
            try publishBusyState(alloc, stdout_writer, master_fd, child_pid, &last_busy_state, false);
            try stdout_writer.flush();
        }

        const now_ms = std.time.milliTimestamp();
        if (now_ms - last_busy_poll_ms >= BUSY_POLL_INTERVAL_MS) {
            last_busy_poll_ms = now_ms;
            try publishBusyState(alloc, stdout_writer, master_fd, child_pid, &last_busy_state, false);
            try stdout_writer.flush();
        }

        if (reapChild(child_pid)) |exit_code| {
            try emitExit(stdout_writer, exit_code);
            try stdout_writer.flush();
            child_done = true;
        }
    }
}
