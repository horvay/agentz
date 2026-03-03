const std = @import("std");
const ghostty_vt = @import("ghostty-vt");

const Command = struct {
    type: []const u8,
    data_b64: ?[]const u8 = null,
    cols: ?u16 = null,
    rows: ?u16 = null,
};

const FrameMessage = struct {
    type: []const u8 = "frame",
    vt_b64: []const u8,
    plain_b64: []const u8,
    cols: u16,
    rows: u16,
    alt_screen: bool,
};

fn writeFrame(
    alloc: std.mem.Allocator,
    stdout_writer: *std.Io.Writer,
    term: *ghostty_vt.Terminal,
) !void {
    const is_alt_screen = term.modes.get(.alt_screen_save_cursor_clear_enter) or
        term.modes.get(.alt_screen) or
        term.modes.get(.alt_screen_legacy);

    // Emit only cursor-position-relevant modes. Avoid replaying all terminal modes.
    var mode_prefix_builder: std.Io.Writer.Allocating = .init(alloc);
    defer mode_prefix_builder.deinit();
    {
        const writer = &mode_prefix_builder.writer;
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
    const mode_prefix = mode_prefix_builder.writer.buffered();

    // Pass A: emit screen state/content, but defer cursor placement.
    var formatter_state: ghostty_vt.formatter.TerminalFormatter = .init(term, .{ .emit = .vt });
    formatter_state.extra = .{
        .palette = false,
        .modes = is_alt_screen,
        .scrolling_region = true,
        .tabstops = false,
        .pwd = false,
        .keyboard = false,
        .screen = .all,
    };
    formatter_state.extra.screen.cursor = false;

    var vt_state_builder: std.Io.Writer.Allocating = .init(alloc);
    defer vt_state_builder.deinit();
    try formatter_state.format(&vt_state_builder.writer);
    const vt_state = vt_state_builder.writer.buffered();

    // Pass B: emit final cursor position last so margins/origin modes cannot shift it afterwards.
    var formatter_cursor: ghostty_vt.formatter.TerminalFormatter = .init(term, .{ .emit = .vt });
    formatter_cursor.content = .none;
    formatter_cursor.extra = .none;
    formatter_cursor.extra.screen.cursor = true;

    var vt_cursor_builder: std.Io.Writer.Allocating = .init(alloc);
    defer vt_cursor_builder.deinit();
    try formatter_cursor.format(&vt_cursor_builder.writer);
    const vt_cursor = vt_cursor_builder.writer.buffered();

    const vt = try std.mem.concat(alloc, u8, &[_][]const u8{
        mode_prefix,
        vt_state,
        vt_cursor,
    });
    defer alloc.free(vt);

    const plain = try term.plainString(alloc);
    defer alloc.free(plain);

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
            .vt_b64 = vt_b64,
            .plain_b64 = plain_b64,
            .cols = @as(u16, @intCast(term.cols)),
            .rows = @as(u16, @intCast(term.rows)),
            .alt_screen = is_alt_screen,
        },
        .{},
        stdout_writer,
    );
    try stdout_writer.writeByte('\n');
    try stdout_writer.flush();
}

pub fn main() !void {
    var gpa: std.heap.DebugAllocator(.{}) = .init;
    defer _ = gpa.deinit();
    const alloc = gpa.allocator();

    var args = try std.process.argsWithAllocator(alloc);
    defer args.deinit();

    _ = args.next(); // binary name
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
            try writeFrame(alloc, stdout_writer, &term);
            continue;
        }

        if (std.mem.eql(u8, cmd.type, "resize")) {
            const next_cols = cmd.cols orelse init_cols;
            const next_rows = cmd.rows orelse init_rows;
            try term.resize(alloc, next_cols, next_rows);
            try writeFrame(alloc, stdout_writer, &term);
            continue;
        }

        if (std.mem.eql(u8, cmd.type, "snapshot")) {
            try writeFrame(alloc, stdout_writer, &term);
            continue;
        }
    }
}
