const std = @import("std");
const ghostty_vt = @import("ghostty-vt");
const win = std.os.windows;

const BUSY_POLL_INTERVAL_MS: i64 = 700;
const LOOP_SLEEP_MS: win.DWORD = 16;
const MAX_OSC_SCAN_BYTES: usize = 16 * 1024;
const STILL_ACTIVE: win.DWORD = 259;
const S_OK: win.HRESULT = 0;
const CREATE_UNICODE_ENVIRONMENT: win.DWORD = 0x00000400;
const EXTENDED_STARTUPINFO_PRESENT: win.DWORD = 0x00080000;
const PROC_THREAD_ATTRIBUTE_NUMBER: win.DWORD = 0x0000FFFF;
const PROC_THREAD_ATTRIBUTE_INPUT: win.DWORD = 0x00020000;
const PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE: win.DWORD = (22 & PROC_THREAD_ATTRIBUTE_NUMBER) | PROC_THREAD_ATTRIBUTE_INPUT;
const PROCESS_TERMINATE: win.DWORD = 0x0001;

const HPCON = win.LPVOID;
const LPPROC_THREAD_ATTRIBUTE_LIST = ?*anyopaque;

fn nextSliceCompat(stream: anytype, input: []const u8) !void {
    const result = stream.nextSlice(input);
    switch (@typeInfo(@TypeOf(result))) {
        .error_union => try result,
        .void => {},
        else => @compileError("unexpected nextSlice return type"),
    }
}

const STARTUPINFOEX = extern struct {
    StartupInfo: win.STARTUPINFOW,
    lpAttributeList: LPPROC_THREAD_ATTRIBUTE_LIST,
};

const PROCESSENTRY32W = extern struct {
    dwSize: win.DWORD,
    cntUsage: win.DWORD,
    th32ProcessID: win.DWORD,
    th32DefaultHeapID: win.ULONG_PTR,
    th32ModuleID: win.DWORD,
    cntThreads: win.DWORD,
    th32ParentProcessID: win.DWORD,
    pcPriClassBase: win.LONG,
    dwFlags: win.DWORD,
    szExeFile: [win.MAX_PATH]win.WCHAR,
};

extern "kernel32" fn CreatePipe(
    hReadPipe: *win.HANDLE,
    hWritePipe: *win.HANDLE,
    lpPipeAttributes: ?*const win.SECURITY_ATTRIBUTES,
    nSize: win.DWORD,
) callconv(.winapi) win.BOOL;

extern "kernel32" fn CreatePseudoConsole(
    size: win.COORD,
    hInput: win.HANDLE,
    hOutput: win.HANDLE,
    dwFlags: win.DWORD,
    phPC: *HPCON,
) callconv(.winapi) win.HRESULT;

extern "kernel32" fn ResizePseudoConsole(hPC: HPCON, size: win.COORD) callconv(.winapi) win.HRESULT;
extern "kernel32" fn ClosePseudoConsole(hPC: HPCON) callconv(.winapi) void;

extern "kernel32" fn InitializeProcThreadAttributeList(
    lpAttributeList: LPPROC_THREAD_ATTRIBUTE_LIST,
    dwAttributeCount: win.DWORD,
    dwFlags: win.DWORD,
    lpSize: *win.SIZE_T,
) callconv(.winapi) win.BOOL;

extern "kernel32" fn UpdateProcThreadAttribute(
    lpAttributeList: LPPROC_THREAD_ATTRIBUTE_LIST,
    dwFlags: win.DWORD,
    Attribute: win.DWORD_PTR,
    lpValue: win.PVOID,
    cbSize: win.SIZE_T,
    lpPreviousValue: ?win.PVOID,
    lpReturnSize: ?*win.SIZE_T,
) callconv(.winapi) win.BOOL;

extern "kernel32" fn DeleteProcThreadAttributeList(
    lpAttributeList: LPPROC_THREAD_ATTRIBUTE_LIST,
) callconv(.winapi) void;

extern "kernel32" fn CreateProcessW(
    lpApplicationName: ?win.LPWSTR,
    lpCommandLine: ?win.LPWSTR,
    lpProcessAttributes: ?*win.SECURITY_ATTRIBUTES,
    lpThreadAttributes: ?*win.SECURITY_ATTRIBUTES,
    bInheritHandles: win.BOOL,
    dwCreationFlags: win.DWORD,
    lpEnvironment: ?*anyopaque,
    lpCurrentDirectory: ?win.LPWSTR,
    lpStartupInfo: *win.STARTUPINFOW,
    lpProcessInformation: *win.PROCESS_INFORMATION,
) callconv(.winapi) win.BOOL;

extern "kernel32" fn PeekNamedPipe(
    hNamedPipe: win.HANDLE,
    lpBuffer: ?win.LPVOID,
    nBufferSize: win.DWORD,
    lpBytesRead: ?*win.DWORD,
    lpTotalBytesAvail: ?*win.DWORD,
    lpBytesLeftThisMessage: ?*win.DWORD,
) callconv(.winapi) win.BOOL;

extern "kernel32" fn OpenProcess(
    dwDesiredAccess: win.DWORD,
    bInheritHandle: win.BOOL,
    dwProcessId: win.DWORD,
) callconv(.winapi) ?win.HANDLE;

extern "kernel32" fn Process32FirstW(
    hSnapshot: win.HANDLE,
    lppe: *PROCESSENTRY32W,
) callconv(.winapi) win.BOOL;

extern "kernel32" fn Process32NextW(
    hSnapshot: win.HANDLE,
    lppe: *PROCESSENTRY32W,
) callconv(.winapi) win.BOOL;

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
    readonly: ghostty_vt.ReadonlyHandler,
    apc: ghostty_vt.apc.Handler = .{},

    pub fn init(alloc: std.mem.Allocator, terminal: *ghostty_vt.Terminal) HostStreamHandler {
        return .{
            .alloc = alloc,
            .terminal = terminal,
            .readonly = terminal.vtHandler(),
        };
    }

    pub fn deinit(self: *HostStreamHandler) void {
        self.apc.deinit();
        self.readonly.deinit();
    }

    pub fn vt(self: *HostStreamHandler, comptime action: ghostty_vt.StreamAction.Tag, value: ghostty_vt.StreamAction.Value(action)) !void {
        switch (action) {
            .apc_start => self.apc.start(),
            .apc_put => self.apc.feed(self.alloc, value),
            .apc_end => {
                var cmd = self.apc.end() orelse return;
                defer cmd.deinit(self.alloc);
                switch (cmd) {
                    .kitty => |*kitty_cmd| {
                        _ = self.terminal.kittyGraphics(self.alloc, kitty_cmd);
                    },
                }
            },
            else => try self.readonly.vt(action, value),
        }
    }
};

const SpawnedChild = struct {
    process_handle: win.HANDLE,
    process_id: win.DWORD,
    input_handle: win.HANDLE,
    output_handle: win.HANDLE,
    pseudo_console: HPCON,
};

const ProcessRelation = struct {
    pid: win.DWORD,
    parent_pid: win.DWORD,
};

fn isAltScreen(term: *ghostty_vt.Terminal) bool {
    return term.modes.get(.alt_screen_save_cursor_clear_enter) or
        term.modes.get(.alt_screen) or
        term.modes.get(.alt_screen_legacy);
}

fn hasVirtualKittyPlacements(term: *ghostty_vt.Terminal) bool {
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
        if (cp == ghostty_vt.kitty.graphics.unicode.placeholder) {
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

    const has_virtual_kitty = hasVirtualKittyPlacements(term);
    const vt = if (use_full) blk: {
        mode = .full;
        if (!alt_screen and !has_virtual_kitty) {
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
        preview_only,
    );
    pending_frame.* = false;
    last_frame_emit_ms.* = now_ms;
    return true;
}

fn emitExit(stdout_writer: *std.Io.Writer, code: i32) !void {
    var payload: std.ArrayList(u8) = .empty;
    defer payload.deinit(std.heap.page_allocator);
    try appendI32(&payload, std.heap.page_allocator, code);
    try writePacket(stdout_writer, .exit, payload.items);
}

fn publishCwd(
    alloc: std.mem.Allocator,
    stdout_writer: *std.Io.Writer,
    last_known_cwd: *[]u8,
    last_published_cwd: *[]u8,
    force: bool,
) !void {
    if (!force and std.mem.eql(u8, last_known_cwd.*, last_published_cwd.*)) return;

    alloc.free(last_published_cwd.*);
    last_published_cwd.* = try alloc.dupe(u8, last_known_cwd.*);

    var payload: std.ArrayList(u8) = .empty;
    defer payload.deinit(alloc);
    try appendU32(&payload, alloc, @intCast(last_known_cwd.*.len));
    try payload.appendSlice(alloc, last_known_cwd.*);
    try writePacket(stdout_writer, .cwd, payload.items);
}

fn snapshotProcessRelationsAlloc(alloc: std.mem.Allocator) ![]ProcessRelation {
    const snapshot = win.kernel32.CreateToolhelp32Snapshot(win.TH32CS_SNAPPROCESS, 0);
    if (snapshot == win.INVALID_HANDLE_VALUE) {
        return win.unexpectedError(win.kernel32.GetLastError());
    }
    defer win.CloseHandle(snapshot);

    var relations: std.ArrayList(ProcessRelation) = .empty;
    errdefer relations.deinit(alloc);

    var entry: PROCESSENTRY32W = undefined;
    entry.dwSize = @sizeOf(PROCESSENTRY32W);
    if (Process32FirstW(snapshot, &entry) == 0) {
        return try relations.toOwnedSlice(alloc);
    }

    while (true) {
        try relations.append(alloc, .{
            .pid = entry.th32ProcessID,
            .parent_pid = entry.th32ParentProcessID,
        });
        entry.dwSize = @sizeOf(PROCESSENTRY32W);
        if (Process32NextW(snapshot, &entry) == 0) break;
    }

    return try relations.toOwnedSlice(alloc);
}

fn resolveBusyState(alloc: std.mem.Allocator, child_pid: win.DWORD) !bool {
    const relations = try snapshotProcessRelationsAlloc(alloc);
    defer alloc.free(relations);

    for (relations) |relation| {
        if (relation.parent_pid == child_pid and relation.pid != 0) {
            return true;
        }
    }
    return false;
}

fn publishBusyState(
    alloc: std.mem.Allocator,
    stdout_writer: *std.Io.Writer,
    child_pid: win.DWORD,
    last_busy_state: *bool,
    force: bool,
) !void {
    const next_busy = resolveBusyState(alloc, child_pid) catch false;
    if (!force and next_busy == last_busy_state.*) return;

    last_busy_state.* = next_busy;
    var payload: std.ArrayList(u8) = .empty;
    defer payload.deinit(alloc);
    try payload.append(alloc, if (next_busy) 1 else 0);
    try appendI64(&payload, alloc, std.time.milliTimestamp());
    try writePacket(stdout_writer, .busy, payload.items);
}

fn hexValue(byte: u8) ?u8 {
    return switch (byte) {
        '0'...'9' => byte - '0',
        'a'...'f' => byte - 'a' + 10,
        'A'...'F' => byte - 'A' + 10,
        else => null,
    };
}

fn percentDecodeAlloc(alloc: std.mem.Allocator, value: []const u8) ![]u8 {
    var out: std.ArrayList(u8) = .empty;
    errdefer out.deinit(alloc);

    var index: usize = 0;
    while (index < value.len) : (index += 1) {
        if (value[index] == '%' and index + 2 < value.len) {
            const hi = hexValue(value[index + 1]);
            const lo = hexValue(value[index + 2]);
            if (hi != null and lo != null) {
                try out.append(alloc, (hi.? << 4) | lo.?);
                index += 2;
                continue;
            }
        }
        try out.append(alloc, value[index]);
    }

    return try out.toOwnedSlice(alloc);
}

fn isDrivePath(value: []const u8) bool {
    return value.len >= 3 and std.ascii.isAlphabetic(value[0]) and value[1] == ':' and (value[2] == '/' or value[2] == '\\');
}

fn normalizeWindowsSlashes(bytes: []u8) void {
    for (bytes) |*byte| {
        if (byte.* == '/') byte.* = '\\';
    }
}

fn decodeOscPath(alloc: std.mem.Allocator, value: []const u8) !?[]u8 {
    const trimmed = std.mem.trim(u8, value, " \t\r\n");
    if (trimmed.len == 0) return null;

    if (isDrivePath(trimmed) or std.mem.startsWith(u8, trimmed, "\\\\")) {
        const direct = try alloc.dupe(u8, trimmed);
        normalizeWindowsSlashes(direct);
        return direct;
    }

    if (!std.mem.startsWith(u8, trimmed, "file://")) return null;

    const rest = trimmed[7..];
    const path_bytes = if (rest.len >= 3 and rest[0] == '/' and std.ascii.isAlphabetic(rest[1]) and rest[2] == ':')
        try percentDecodeAlloc(alloc, rest[1..])
    else if (std.mem.startsWith(u8, rest, "localhost/"))
        try percentDecodeAlloc(alloc, rest[10..])
    else blk: {
        const slash = std.mem.indexOfScalar(u8, rest, '/') orelse return null;
        const host = rest[0..slash];
        const tail = rest[slash + 1 ..];
        if (host.len == 0) return null;
        const decoded_tail = try percentDecodeAlloc(alloc, tail);
        defer alloc.free(decoded_tail);
        var unc: std.ArrayList(u8) = .empty;
        errdefer unc.deinit(alloc);
        try unc.appendSlice(alloc, "\\\\");
        try unc.appendSlice(alloc, host);
        if (decoded_tail.len > 0) {
            try unc.append(alloc, '\\');
            try unc.appendSlice(alloc, decoded_tail);
        }
        break :blk try unc.toOwnedSlice(alloc);
    };
    normalizeWindowsSlashes(path_bytes);
    return path_bytes;
}

fn scanOscCwd(
    alloc: std.mem.Allocator,
    osc_buffer: *std.ArrayList(u8),
    chunk: []const u8,
    last_known_cwd: *[]u8,
) !void {
    try osc_buffer.appendSlice(alloc, chunk);
    if (osc_buffer.items.len > MAX_OSC_SCAN_BYTES) {
        const keep = MAX_OSC_SCAN_BYTES / 2;
        const offset = osc_buffer.items.len - keep;
        std.mem.copyForwards(u8, osc_buffer.items[0..keep], osc_buffer.items[offset..]);
        osc_buffer.items.len = keep;
    }

    const patterns = [_][]const u8{ "\x1b]7;", "\x1b]9;9;" };
    var latest: ?[]const u8 = null;

    for (patterns) |pattern| {
        var search_from: usize = 0;
        while (std.mem.indexOf(u8, osc_buffer.items[search_from..], pattern)) |relative_start| {
            const start = search_from + relative_start + pattern.len;
            var end = start;
            var found = false;
            while (end < osc_buffer.items.len) : (end += 1) {
                if (osc_buffer.items[end] == 0x07) {
                    latest = osc_buffer.items[start..end];
                    found = true;
                    break;
                }
                if (osc_buffer.items[end] == 0x1b and end + 1 < osc_buffer.items.len and osc_buffer.items[end + 1] == '\\') {
                    latest = osc_buffer.items[start..end];
                    found = true;
                    break;
                }
            }
            if (!found) break;
            search_from = end + 1;
        }
    }

    if (latest) |raw| {
        const decoded = try decodeOscPath(alloc, raw);
        if (decoded) |next| {
            defer alloc.free(next);
            if (!std.mem.eql(u8, next, last_known_cwd.*)) {
                alloc.free(last_known_cwd.*);
                last_known_cwd.* = try alloc.dupe(u8, next);
            }
        }
    }
}

fn decodeInput(alloc: std.mem.Allocator, encoded: []const u8) ![]u8 {
    const decoded_len = try std.base64.standard.Decoder.calcSizeForSlice(encoded);
    const decoded = try alloc.alloc(u8, decoded_len);
    errdefer alloc.free(decoded);
    _ = try std.base64.standard.Decoder.decode(decoded, encoded);
    return decoded;
}

fn windowsCreateCommandLineW(alloc: std.mem.Allocator, argv: []const []const u8) ![:0]u16 {
    var buf: std.ArrayList(u8) = .empty;
    defer buf.deinit(alloc);

    if (argv.len != 0) {
        const arg0 = argv[0];
        var needs_quotes = arg0.len == 0;
        for (arg0) |char| {
            if (char <= ' ') {
                needs_quotes = true;
            } else if (char == '"') {
                return error.InvalidArg0;
            }
        }
        if (needs_quotes) {
            try buf.append(alloc, '"');
            try buf.appendSlice(alloc, arg0);
            try buf.append(alloc, '"');
        } else {
            try buf.appendSlice(alloc, arg0);
        }

        for (argv[1..]) |arg| {
            try buf.append(alloc, ' ');
            needs_quotes = for (arg) |char| {
                if (char <= ' ' or char == '"') break true;
            } else arg.len == 0;
            if (!needs_quotes) {
                try buf.appendSlice(alloc, arg);
                continue;
            }

            try buf.append(alloc, '"');
            var backslash_count: usize = 0;
            for (arg) |byte| {
                switch (byte) {
                    '\\' => {
                        backslash_count += 1;
                    },
                    '"' => {
                        try buf.appendNTimes(alloc, '\\', backslash_count * 2 + 1);
                        try buf.append(alloc, '"');
                        backslash_count = 0;
                    },
                    else => {
                        try buf.appendNTimes(alloc, '\\', backslash_count);
                        try buf.append(alloc, byte);
                        backslash_count = 0;
                    },
                }
            }
            try buf.appendNTimes(alloc, '\\', backslash_count * 2);
            try buf.append(alloc, '"');
        }
    }

    return try std.unicode.wtf8ToWtf16LeAllocZ(alloc, buf.items);
}

fn isPathLikeCommand(command: []const u8) bool {
    return std.mem.indexOfAny(u8, command, "\\/:") != null;
}

fn closeHandleMaybe(handle: *?win.HANDLE) void {
    if (handle.*) |value| {
        win.CloseHandle(value);
        handle.* = null;
    }
}

fn closePseudoConsoleMaybe(handle: *?HPCON) void {
    if (handle.*) |value| {
        ClosePseudoConsole(value);
        handle.* = null;
    }
}

fn spawnChild(alloc: std.mem.Allocator, startup: StartupConfig) !SpawnedChild {
    var argv: std.ArrayList([]const u8) = .empty;
    defer argv.deinit(alloc);
    try argv.append(alloc, startup.command);
    for (startup.args) |arg| try argv.append(alloc, arg);

    const application_w = if (isPathLikeCommand(startup.command))
        try std.unicode.wtf8ToWtf16LeAllocZ(alloc, startup.command)
    else
        null;
    defer if (application_w) |value| alloc.free(value);

    const command_line_w = try windowsCreateCommandLineW(alloc, argv.items);
    defer alloc.free(command_line_w);
    const cwd_w = try std.unicode.wtf8ToWtf16LeAllocZ(alloc, startup.cwd);
    defer alloc.free(cwd_w);

    const security_attributes = win.SECURITY_ATTRIBUTES{
        .nLength = @sizeOf(win.SECURITY_ATTRIBUTES),
        .lpSecurityDescriptor = null,
        .bInheritHandle = win.FALSE,
    };

    var input_read: ?win.HANDLE = null;
    var input_write: ?win.HANDLE = null;
    var output_read: ?win.HANDLE = null;
    var output_write: ?win.HANDLE = null;
    var pseudo_console: ?HPCON = null;
    errdefer closePseudoConsoleMaybe(&pseudo_console);
    errdefer closeHandleMaybe(&input_read);
    errdefer closeHandleMaybe(&input_write);
    errdefer closeHandleMaybe(&output_read);
    errdefer closeHandleMaybe(&output_write);

    if (CreatePipe(&input_read.?, &input_write.?, &security_attributes, 0) == 0) {
        return win.unexpectedError(win.kernel32.GetLastError());
    }
    if (CreatePipe(&output_read.?, &output_write.?, &security_attributes, 0) == 0) {
        return win.unexpectedError(win.kernel32.GetLastError());
    }

    var pseudo_console_raw: HPCON = undefined;
    const create_pc_result = CreatePseudoConsole(
        .{ .X = @intCast(startup.cols), .Y = @intCast(startup.rows) },
        input_read.?,
        output_write.?,
        0,
        &pseudo_console_raw,
    );
    if (create_pc_result != S_OK) return error.CreatePseudoConsoleFailed;
    pseudo_console = pseudo_console_raw;

    var attribute_list_size: win.SIZE_T = 0;
    _ = InitializeProcThreadAttributeList(null, 1, 0, &attribute_list_size);
    const attribute_list_buf = try alloc.alloc(u8, attribute_list_size);
    defer alloc.free(attribute_list_buf);

    if (InitializeProcThreadAttributeList(attribute_list_buf.ptr, 1, 0, &attribute_list_size) == 0) {
        return win.unexpectedError(win.kernel32.GetLastError());
    }
    defer DeleteProcThreadAttributeList(attribute_list_buf.ptr);

    if (UpdateProcThreadAttribute(
        attribute_list_buf.ptr,
        0,
        PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE,
        pseudo_console.?,
        @sizeOf(HPCON),
        null,
        null,
    ) == 0) {
        return win.unexpectedError(win.kernel32.GetLastError());
    }

    var startup_info_ex = STARTUPINFOEX{
        .StartupInfo = .{
            .cb = @sizeOf(STARTUPINFOEX),
            .lpReserved = null,
            .lpDesktop = null,
            .lpTitle = null,
            .dwX = 0,
            .dwY = 0,
            .dwXSize = 0,
            .dwYSize = 0,
            .dwXCountChars = 0,
            .dwYCountChars = 0,
            .dwFillAttribute = 0,
            .dwFlags = win.STARTF_USESTDHANDLES,
            .wShowWindow = 0,
            .cbReserved2 = 0,
            .lpReserved2 = null,
            .hStdInput = win.INVALID_HANDLE_VALUE,
            .hStdOutput = win.INVALID_HANDLE_VALUE,
            .hStdError = win.INVALID_HANDLE_VALUE,
        },
        .lpAttributeList = attribute_list_buf.ptr,
    };

    var process_information: win.PROCESS_INFORMATION = undefined;
    if (CreateProcessW(
        if (application_w) |value| @constCast(value.ptr) else null,
        @constCast(command_line_w.ptr),
        null,
        null,
        win.FALSE,
        CREATE_UNICODE_ENVIRONMENT | EXTENDED_STARTUPINFO_PRESENT,
        null,
        @constCast(cwd_w.ptr),
        @ptrCast(&startup_info_ex.StartupInfo),
        &process_information,
    ) == 0) {
        return win.unexpectedError(win.kernel32.GetLastError());
    }

    win.CloseHandle(process_information.hThread);
    closeHandleMaybe(&input_read);
    closeHandleMaybe(&output_write);

    return .{
        .process_handle = process_information.hProcess,
        .process_id = process_information.dwProcessId,
        .input_handle = input_write.?,
        .output_handle = output_read.?,
        .pseudo_console = pseudo_console.?,
    };
}

fn peekPipeAvailable(handle: win.HANDLE) !?u32 {
    var available: win.DWORD = 0;
    if (PeekNamedPipe(handle, null, 0, null, &available, null) == 0) {
        return switch (win.kernel32.GetLastError()) {
            .BROKEN_PIPE, .PIPE_NOT_CONNECTED => null,
            else => |err| win.unexpectedError(err),
        };
    }
    return available;
}

fn readPipeSome(handle: win.HANDLE, buffer: []u8) !?usize {
    const read_len = win.ReadFile(handle, buffer, null) catch |err| return switch (err) {
        error.BrokenPipe => null,
        else => err,
    };
    if (read_len == 0) return null;
    return read_len;
}

fn writeAllHandle(handle: win.HANDLE, bytes: []const u8) !void {
    var offset: usize = 0;
    while (offset < bytes.len) {
        const written = try win.WriteFile(handle, bytes[offset..], null);
        if (written == 0) return error.ZeroByteWrite;
        offset += written;
    }
}

fn pollChildExit(process_handle: win.HANDLE) !?i32 {
    var exit_code: win.DWORD = 0;
    if (win.kernel32.GetExitCodeProcess(process_handle, &exit_code) == 0) {
        return win.unexpectedError(win.kernel32.GetLastError());
    }
    if (exit_code == STILL_ACTIVE) return null;
    return @bitCast(exit_code);
}

fn pidInList(list: []const win.DWORD, pid: win.DWORD) bool {
    for (list) |entry| {
        if (entry == pid) return true;
    }
    return false;
}

fn collectProcessTreeAlloc(alloc: std.mem.Allocator, root_pid: win.DWORD) ![]win.DWORD {
    const relations = try snapshotProcessRelationsAlloc(alloc);
    defer alloc.free(relations);

    var tree: std.ArrayList(win.DWORD) = .empty;
    errdefer tree.deinit(alloc);
    try tree.append(alloc, root_pid);

    var index: usize = 0;
    while (index < tree.items.len) : (index += 1) {
        const parent = tree.items[index];
        for (relations) |relation| {
            if (relation.parent_pid != parent or relation.pid == 0) continue;
            if (pidInList(tree.items, relation.pid)) continue;
            try tree.append(alloc, relation.pid);
        }
    }

    return try tree.toOwnedSlice(alloc);
}

fn terminatePid(pid: win.DWORD) void {
    const handle = OpenProcess(PROCESS_TERMINATE, win.FALSE, pid) orelse return;
    defer win.CloseHandle(handle);
    win.TerminateProcess(handle, 1) catch {};
}

fn killProcessTree(alloc: std.mem.Allocator, root_pid: win.DWORD) void {
    const tree = collectProcessTreeAlloc(alloc, root_pid) catch {
        terminatePid(root_pid);
        return;
    };
    defer alloc.free(tree);

    var index = tree.len;
    while (index > 0) {
        index -= 1;
        terminatePid(tree[index]);
    }
}

fn resizeTerminal(term: *ghostty_vt.Terminal, alloc: std.mem.Allocator, pseudo_console: HPCON, cols: u16, rows: u16) !void {
    const result = ResizePseudoConsole(pseudo_console, .{ .X = @intCast(cols), .Y = @intCast(rows) });
    if (result != S_OK) return error.ResizePseudoConsoleFailed;
    try term.resize(alloc, cols, rows);
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

    var current_pixel_width: u16 = 0;
    var current_pixel_height: u16 = 0;

    var stdout_file = std.fs.File.stdout();
    var stdout_buf: [4096]u8 = undefined;
    var stdout_writer_state = stdout_file.writer(&stdout_buf);
    const stdout_writer = &stdout_writer_state.interface;

    const child = try spawnChild(alloc, startup);
    var process_handle: ?win.HANDLE = child.process_handle;
    var input_handle: ?win.HANDLE = child.input_handle;
    var output_handle: ?win.HANDLE = child.output_handle;
    var pseudo_console: ?HPCON = child.pseudo_console;
    const child_pid = child.process_id;
    defer closeHandleMaybe(&process_handle);
    defer closeHandleMaybe(&input_handle);
    defer closeHandleMaybe(&output_handle);
    defer closePseudoConsoleMaybe(&pseudo_console);

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
    var output_open = true;
    var child_done = false;

    var stdin_buffer = std.ArrayList(u8).empty;
    defer stdin_buffer.deinit(alloc);
    var osc_buffer = std.ArrayList(u8).empty;
    defer osc_buffer.deinit(alloc);
    const stdin_handle = std.fs.File.stdin().handle;

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
        preview_only,
    );
    last_frame_emit_ms = std.time.milliTimestamp();
    try publishBusyState(alloc, stdout_writer, child_pid, &last_busy_state, true);
    try publishCwd(alloc, stdout_writer, &last_known_cwd, &last_published_cwd, true);
    try stdout_writer.flush();

    while (!child_done) {
        var did_work = false;

        if (stdin_open) {
            const available = peekPipeAvailable(stdin_handle) catch |err| return err;
            if (available == null) {
                stdin_open = false;
                killProcessTree(alloc, child_pid);
                did_work = true;
            } else if (available.? > 0) {
                var read_buf: [8192]u8 = undefined;
                const read_len = (try readPipeSome(stdin_handle, read_buf[0..@min(read_buf.len, @as(usize, @intCast(available.?)))])) orelse 0;
                if (read_len == 0) {
                    stdin_open = false;
                    killProcessTree(alloc, child_pid);
                } else {
                    try stdin_buffer.appendSlice(alloc, read_buf[0..read_len]);
                    did_work = true;
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
                            if (input_handle) |handle| {
                                writeAllHandle(handle, decoded) catch {};
                            }
                            try publishBusyState(alloc, stdout_writer, child_pid, &last_busy_state, false);
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
                            if (pseudo_console) |handle| {
                                resizeTerminal(&term, alloc, handle, next_cols, next_rows) catch {};
                            }
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
                                preview_only,
                            );
                            pending_frame = false;
                            last_frame_emit_ms = std.time.milliTimestamp();
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
                                false,
                            );
                            pending_frame = false;
                            last_frame_emit_ms = std.time.milliTimestamp();
                            try stdout_writer.flush();
                            continue;
                        }

                        if (std.mem.eql(u8, cmd.type, "cwd")) {
                            try publishCwd(alloc, stdout_writer, &last_known_cwd, &last_published_cwd, true);
                            try stdout_writer.flush();
                            continue;
                        }

                        if (std.mem.eql(u8, cmd.type, "busy")) {
                            try publishBusyState(alloc, stdout_writer, child_pid, &last_busy_state, true);
                            try stdout_writer.flush();
                            continue;
                        }

                        if (std.mem.eql(u8, cmd.type, "kill")) {
                            killProcessTree(alloc, child_pid);
                            continue;
                        }
                    }
                }
            }
        }

        if (!flow_paused and output_open and output_handle != null) {
            const available = try peekPipeAvailable(output_handle.?);
            if (available == null) {
                output_open = false;
                did_work = true;
            } else if (available.? > 0) {
                var pty_buf: [65536]u8 = undefined;
                const read_len = (try readPipeSome(output_handle.?, pty_buf[0..@min(pty_buf.len, @as(usize, @intCast(available.?)))])) orelse 0;
                if (read_len == 0) {
                    output_open = false;
                } else {
                    const bytes = pty_buf[0..read_len];
                    try nextSliceCompat(&stream, bytes);
                    try pending_vt_bytes.appendSlice(alloc, bytes);
                    try scanOscCwd(alloc, &osc_buffer, bytes, &last_known_cwd);
                    pending_frame = true;
                    did_work = true;
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
                        try publishCwd(alloc, stdout_writer, &last_known_cwd, &last_published_cwd, false);
                        try publishBusyState(alloc, stdout_writer, child_pid, &last_busy_state, false);
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
            try publishCwd(alloc, stdout_writer, &last_known_cwd, &last_published_cwd, false);
            try publishBusyState(alloc, stdout_writer, child_pid, &last_busy_state, false);
            try stdout_writer.flush();
            did_work = true;
        }

        const now_ms = std.time.milliTimestamp();
        if (now_ms - last_busy_poll_ms >= BUSY_POLL_INTERVAL_MS) {
            last_busy_poll_ms = now_ms;
            try publishBusyState(alloc, stdout_writer, child_pid, &last_busy_state, false);
            try stdout_writer.flush();
            did_work = true;
        }

        if (process_handle) |handle| {
            if (try pollChildExit(handle)) |exit_code| {
                try emitExit(stdout_writer, exit_code);
                try stdout_writer.flush();
                child_done = true;
                did_work = true;
            }
        }

        if (!did_work) {
            var sleep_ms: win.DWORD = LOOP_SLEEP_MS;
            if (!flow_paused and pending_frame and frame_interval_ms > 0) {
                const remaining_ms = frame_interval_ms - (std.time.milliTimestamp() - last_frame_emit_ms);
                if (remaining_ms <= 0) {
                    sleep_ms = 0;
                } else if (remaining_ms < sleep_ms) {
                    sleep_ms = @intCast(remaining_ms);
                }
            }
            win.kernel32.Sleep(sleep_ms);
        }
    }
}
