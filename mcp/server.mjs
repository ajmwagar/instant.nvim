#!/usr/bin/env node
/**
 * instant-mcp — a tiny MCP server that edits a *running* Neovim instance.
 *
 * Design: the agent talks MCP -> this server -> Neovim's msgpack-RPC socket.
 * Neovim applies the edit in the live buffer, so it appears immediately in
 * every attached UI. If that Neovim is also in an instant.nvim session, the
 * edit is relayed to every other instant client. instant.nvim owns fan-out;
 * this server only needs to reach one live Neovim.
 *
 * No daemon and no config file are required: the socket is discovered from
 * $NVIM / $INSTANT_MCP_NVIM, or by scanning the usual Neovim socket dirs.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import neovim from "neovim";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const log = (...args) => process.stderr.write(`[instant-mcp] ${args.join(" ")}\n`);

// ---------------------------------------------------------------------------
// CLI / environment
// ---------------------------------------------------------------------------

function argValue(flag) {
  const i = process.argv.indexOf(flag);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

const CLI_SOCKET = argValue("--socket");
const CLI_FILE = argValue("--file");
const WANT_FILE = CLI_FILE || process.env.INSTANT_MCP_FILE;

// ---------------------------------------------------------------------------
// Socket discovery
// ---------------------------------------------------------------------------

function parseAddress(raw) {
  if (!raw) return undefined;
  // "127.0.0.1:6666" / "[::1]:6666" -> TCP, anything else -> unix socket path
  const m = /^\[?([^\]]+)\]?:(\d+)$/.exec(raw);
  if (m && !raw.startsWith("/")) return { host: m[1], port: Number(m[2]) };
  return raw;
}

function listSocketFiles() {
  const found = [];
  const roots = [os.tmpdir(), process.env.XDG_RUNTIME_DIR, "/tmp"].filter(Boolean);
  for (const root of new Set(roots)) {
    let entries;
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.name.startsWith("nvim.")) continue;
      const base = path.join(root, entry.name);
      const walk = (dir, depth) => {
        if (depth > 2) return;
        let inner;
        try {
          inner = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
          return;
        }
        for (const child of inner) {
          const full = path.join(dir, child.name);
          if (child.isDirectory()) {
            walk(full, depth + 1);
          } else if (child.name.endsWith(".0")) {
            try {
              if (fs.statSync(full).isSocket()) found.push(full);
            } catch {
              /* raced away */
            }
          }
        }
      };
      walk(base, 0);
    }
  }
  // Newest first: usually the nvim you just started.
  return [...new Set(found)]
    .map((p) => {
      try {
        return { p, mtime: fs.statSync(p).mtimeMs };
      } catch {
        return { p, mtime: 0 };
      }
    })
    .sort((a, b) => b.mtime - a.mtime)
    .map((x) => x.p);
}

function candidateAddresses() {
  const explicit = [
    CLI_SOCKET,
    process.env.INSTANT_MCP_NVIM,
    process.env.NVIM,
  ].filter(Boolean);
  return [...new Set([...explicit, ...listSocketFiles()])].map(parseAddress);
}

// ---------------------------------------------------------------------------
// Neovim connection
// ---------------------------------------------------------------------------

let conn = null;
let connecting = null;

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function connect() {
  const addresses = candidateAddresses();
  if (addresses.length === 0) {
    throw new Error(
      "No running Neovim found. Start one with --listen, or set INSTANT_MCP_NVIM to its socket path.",
    );
  }

  let lastError;
  for (const address of addresses) {
    let nv;
    try {
      nv = neovim.attach(typeof address === "string" ? { socket: address } : address);
      await withTimeout(nv.request("nvim_get_current_buf"), 2000, "connect");

      if (WANT_FILE) {
        const bufs = await nv.request("nvim_list_bufs");
        const names = await Promise.all(
          bufs.map((b) => nv.request("nvim_buf_get_name", [b]).catch(() => "")),
        );
        const wanted = path.resolve(WANT_FILE);
        if (!names.some((n) => n === wanted || n.endsWith(`/${WANT_FILE}`))) {
          nv.close();
          continue;
        }
      }

      conn = { nv, address };
      if (typeof nv.on === "function") {
        nv.on("disconnect", () => {
          if (conn && conn.nv === nv) conn = null;
        });
      }
      log(`connected to ${typeof address === "string" ? address : JSON.stringify(address)}`);
      return conn;
    } catch (error) {
      lastError = error;
      try {
        nv?.close();
      } catch {
        /* ignore */
      }
    }
  }

  throw new Error(
    `Could not attach to any Neovim (${addresses.length} candidate(s)). ` +
      `Last error: ${lastError?.message ?? "unknown"}. ` +
      `Set INSTANT_MCP_NVIM=/path/to/socket if discovery picked the wrong one.`,
  );
}

async function nvim() {
  if (conn) return conn;
  if (!connecting) connecting = connect().finally(() => (connecting = null));
  return connecting;
}

async function rpc(method, args = []) {
  const { nv } = await nvim();
  try {
    return await nv.request(method, args);
  } catch (error) {
    // A dead socket must not poison the rest of the session.
    if (/closed|EPIPE|ECONNRESET|disconnected/i.test(error?.message ?? "")) conn = null;
    throw error;
  }
}

const lua = (code, args = []) => rpc("nvim_exec_lua", [code, args]);

// The node client wraps integer handles (Buffer/Tabpage/Window) in objects.
const bufferId = (b) => (b && typeof b === "object" ? (b.id ?? b.data ?? b) : b);

// ---------------------------------------------------------------------------
// Buffer helpers
// ---------------------------------------------------------------------------

async function resolveBuffer({ path: file, bufnr } = {}) {
  if (typeof bufnr === "number") {
    return { bufnr, name: await rpc("nvim_buf_get_name", [bufnr]) };
  }
  if (!file) {
    const current = bufferId(await rpc("nvim_get_current_buf"));
    return { bufnr: current, name: await rpc("nvim_buf_get_name", [current]) };
  }

  const wanted = path.resolve(file.replace(/^~(?=$|\/)/, os.homedir()));
  const bufs = await rpc("nvim_list_bufs");
  for (const raw of bufs) {
    const b = bufferId(raw);
    const name = await rpc("nvim_buf_get_name", [b]);
    if (name === wanted || name === file || name.endsWith(`/${file}`)) {
      return { bufnr: b, name };
    }
  }

  if (!fs.existsSync(wanted)) {
    throw new Error(`No loaded buffer for "${file}" and no such file on disk.`);
  }

  // Load it into the current window so the human can see what the agent is doing.
  const loaded = await lua(
    `local p = ...
     vim.cmd("edit " .. vim.fn.fnameescape(p))
     return vim.api.nvim_get_current_buf()`,
    [wanted],
  );
  return { bufnr: bufferId(loaded), name: await rpc("nvim_buf_get_name", [bufferId(loaded)]) };
}

async function lineCount(bufnr) {
  return rpc("nvim_buf_line_count", [bufnr]);
}

async function getLines(bufnr, start = 1, end = Infinity) {
  const total = await lineCount(bufnr);
  const from = Math.max(1, start);
  const to = end === Infinity || end === -1 ? total : Math.min(total, end);
  if (from > to) return { lines: [], total, from, to };
  const lines = await rpc("nvim_buf_get_lines", [bufnr, from - 1, to, true]);
  return { lines, total, from, to };
}

function numbered(lines, from) {
  const width = String(from + lines.length - 1).length;
  return lines
    .map((line, i) => `${String(from + i).padStart(width)}│${line}`)
    .join("\n");
}

function ok(text) {
  return { content: [{ type: "text", text }] };
}

function fail(error) {
  return {
    content: [{ type: "text", text: `Error: ${error?.message ?? error}` }],
    isError: true,
  };
}

async function saveIfRequested(bufnr, save) {
  if (!save) return false;
  await lua(
    `local buf = ...
     vim.api.nvim_buf_call(buf, function() vim.cmd("silent write") end)
     return true`,
    [bufnr],
  );
  return true;
}

// ---------------------------------------------------------------------------
// MCP tools
// ---------------------------------------------------------------------------

const server = new McpServer({
  name: "instant-nvim",
  version: "0.1.0",
});

const targetShape = {
  path: z
    .string()
    .optional()
    .describe("File path or unique suffix. Defaults to the current buffer."),
  bufnr: z.number().int().positive().optional().describe("Neovim buffer number (overrides path)."),
};

server.registerTool(
  "nvim_status",
  {
    title: "Neovim status",
    description:
      "Show the live Neovim instance: socket, cwd, current buffer, cursor, mode, Instant username.",
    inputSchema: {},
  },
  async () => {
    try {
      const { address } = await nvim();
      const status = await lua(`
        local b = vim.api.nvim_get_current_buf()
        local cursor = vim.api.nvim_win_get_cursor(0)
        local function str(v) return type(v) == "string" and v or nil end
        return {
          cwd = vim.fn.getcwd(),
          bufnr = b,
          name = vim.api.nvim_buf_get_name(b),
          line = cursor[1],
          col = cursor[2],
          mode = vim.api.nvim_get_mode().mode,
          modified = vim.bo[b].modified,
          lines = vim.api.nvim_buf_line_count(b),
          uis = #vim.api.nvim_list_uis(),
          instant = str(vim.g.instant_username),
        }`);
      return ok(
        [
          `socket:   ${typeof address === "string" ? address : JSON.stringify(address)}`,
          `cwd:      ${status.cwd}`,
          `buffer:   ${status.name || "[No Name]"} (bufnr ${status.bufnr}, ${status.lines} lines${status.modified ? ", modified" : ""})`,
          `cursor:   ${status.line}:${status.col + 1}`,
          `mode:     ${status.mode}`,
          `UIs:      ${status.uis}`,
          `instant:  ${status.instant ?? "not sharing (instant.nvim not joined)"}`,
        ].join("\n"),
      );
    } catch (error) {
      return fail(error);
    }
  },
);

server.registerTool(
  "nvim_list_buffers",
  {
    title: "List Neovim buffers",
    description: "List loaded buffers with name, line count and modified state.",
    inputSchema: {},
  },
  async () => {
    try {
      const bufs = await lua(`
        local out = {}
        for _, b in ipairs(vim.api.nvim_list_bufs()) do
          if vim.api.nvim_buf_is_loaded(b) then
            out[#out + 1] = {
              bufnr = b,
              name = vim.api.nvim_buf_get_name(b),
              modified = vim.bo[b].modified,
              lines = vim.api.nvim_buf_line_count(b),
              current = b == vim.api.nvim_get_current_buf(),
            }
          end
        end
        return out`);
      if (!bufs.length) return ok("No loaded buffers.");
      const text = bufs
        .map(
          (b) =>
            `${b.current ? "*" : " "} ${String(b.bufnr).padStart(3)}  ${b.name || "[No Name]"}  ` +
            `(${b.lines} lines${b.modified ? ", modified" : ""})`,
        )
        .join("\n");
      return ok(`* = current\n${text}`);
    } catch (error) {
      return fail(error);
    }
  },
);

server.registerTool(
  "nvim_read",
  {
    title: "Read buffer lines",
    description:
      "Read a live buffer with 1-based line numbers. Defaults to the current buffer and the whole file.",
    inputSchema: {
      ...targetShape,
      start: z.number().int().positive().optional().describe("First line (1-based, inclusive)."),
      end: z.number().int().positive().optional().describe("Last line (1-based, inclusive)."),
    },
  },
  async ({ path: file, bufnr: buf, start = 1, end }) => {
    try {
      const target = await resolveBuffer({ path: file, bufnr: buf });
      const { lines, total, from, to } = await getLines(target.bufnr, start, end ?? Infinity);
      const modified = await lua(`local buf = ... return vim.bo[buf].modified`, [target.bufnr]);
      const header =
        `${target.name || "[No Name]"} (bufnr ${target.bufnr}, ${total} lines` +
        `${modified ? ", unsaved" : ""}) — lines ${lines.length ? `${from}-${to}` : "none"}`;
      return ok(lines.length ? `${header}\n${numbered(lines, from)}` : `${header}\n(empty range)`);
    } catch (error) {
      return fail(error);
    }
  },
);

server.registerTool(
  "nvim_open",
  {
    title: "Open a file in Neovim",
    description: "Show a file in the live Neovim UI, optionally moving the cursor.",
    inputSchema: {
      path: z.string().describe("File to open in the current window."),
      line: z.number().int().positive().optional(),
      col: z.number().int().positive().optional().describe("1-based column."),
    },
  },
  async ({ path: file, line, col = 1 }) => {
    try {
      const bufnr = await lua(
        `local p, line, col = ...
         vim.cmd("edit " .. vim.fn.fnameescape(p))
         local buf = vim.api.nvim_get_current_buf()
         if line and line > 0 then
           pcall(vim.api.nvim_win_set_cursor, 0, { math.min(line, vim.api.nvim_buf_line_count(buf)), col - 1 })
           vim.cmd("normal! zz")
         end
         return buf`,
        [path.resolve(file.replace(/^~(?=$|\/)/, os.homedir())), line ?? 0, col],
      );
      const name = await rpc("nvim_buf_get_name", [bufnr]);
      return ok(`Opened ${name || file}${line ? ` at ${line}:${col}` : ""} (bufnr ${bufnr}).`);
    } catch (error) {
      return fail(error);
    }
  },
);

server.registerTool(
  "nvim_replace_lines",
  {
    title: "Replace buffer lines",
    description:
      "Replace lines [start, end] (1-based, inclusive) in a live buffer. Use nvim_insert_lines to add lines without replacing.",
    inputSchema: {
      ...targetShape,
      start: z.number().int().positive().describe("First line to replace (1-based)."),
      end: z.number().int().positive().optional().describe("Last line to replace, inclusive. Defaults to start."),
      lines: z.array(z.string()).describe("Replacement lines."),
      save: z.boolean().optional().describe("Write the buffer after editing. Default false."),
    },
  },
  async ({ path: file, bufnr: buf, start, end = start, lines, save = false }) => {
    try {
      const target = await resolveBuffer({ path: file, bufnr: buf });
      const total = await lineCount(target.bufnr);
      if (start > total + 1 || end > total) {
        throw new Error(`Range ${start}-${end} is outside the buffer (${total} lines).`);
      }
      if (end < start) throw new Error(`end (${end}) must be >= start (${start}).`);
      await rpc("nvim_buf_set_lines", [target.bufnr, start - 1, end, true, lines]);
      const saved = await saveIfRequested(target.bufnr, save);
      const now = await lineCount(target.bufnr);
      return ok(
        `Replaced lines ${start}-${end} of ${target.name || `bufnr ${target.bufnr}`} ` +
          `with ${lines.length} line(s); buffer now has ${now} lines${saved ? "; written to disk" : ""}.`,
      );
    } catch (error) {
      return fail(error);
    }
  },
);

server.registerTool(
  "nvim_insert_lines",
  {
    title: "Insert buffer lines",
    description:
      "Insert lines before a 1-based line number. line = current line count + 1 appends at the end.",
    inputSchema: {
      ...targetShape,
      line: z.number().int().positive().describe("Insert before this 1-based line."),
      lines: z.array(z.string()).describe("Lines to insert."),
      save: z.boolean().optional().describe("Write the buffer after editing. Default false."),
    },
  },
  async ({ path: file, bufnr: buf, line, lines, save = false }) => {
    try {
      const target = await resolveBuffer({ path: file, bufnr: buf });
      const total = await lineCount(target.bufnr);
      if (line > total + 1) {
        throw new Error(`Cannot insert before line ${line}; buffer has ${total} lines.`);
      }
      await rpc("nvim_buf_set_lines", [target.bufnr, line - 1, line - 1, true, lines]);
      const saved = await saveIfRequested(target.bufnr, save);
      const now = await lineCount(target.bufnr);
      return ok(
        `Inserted ${lines.length} line(s) at ${line} in ${target.name || `bufnr ${target.bufnr}`}; ` +
          `buffer now has ${now} lines${saved ? "; written to disk" : ""}.`,
      );
    } catch (error) {
      return fail(error);
    }
  },
);

server.registerTool(
  "nvim_replace_text",
  {
    title: "Find and replace in a buffer",
    description:
      "Literal (default) or regex find/replace across a live buffer. Does not save unless save=true.",
    inputSchema: {
      ...targetShape,
      find: z.string().min(1).describe("Text or pattern to find."),
      replace: z.string().describe("Replacement text ($1 style groups with regex=true)."),
      all: z.boolean().optional().describe("Replace every occurrence (default true)."),
      regex: z.boolean().optional().describe("Treat find as a JavaScript regex (default false)."),
      save: z.boolean().optional().describe("Write the buffer after editing. Default false."),
    },
  },
  async ({ path: file, bufnr: buf, find, replace, all = true, regex = false, save = false }) => {
    try {
      const target = await resolveBuffer({ path: file, bufnr: buf });
      const total = await lineCount(target.bufnr);
      const lines = total
        ? await rpc("nvim_buf_get_lines", [target.bufnr, 0, total, true])
        : [];
      const content = lines.join("\n");

      const escaped = find.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const pattern = regex ? find : escaped;
      const counter = new RegExp(pattern, "g");
      const count = [...content.matchAll(counter)].length;
      if (count === 0) return ok(`No match for ${JSON.stringify(find)}.`);
      if (!all && count > 1) {
        const first = new RegExp(pattern);
        const updated = content.replace(first, replace);
        await rpc("nvim_buf_set_lines", [target.bufnr, 0, total, true, updated.split("\n")]);
      } else {
        const updated = content.replace(counter, replace);
        await rpc("nvim_buf_set_lines", [target.bufnr, 0, total, true, updated.split("\n")]);
      }

      const saved = await saveIfRequested(target.bufnr, save);
      const changed = all ? count : 1;
      return ok(
        `Replaced ${changed} occurrence(s) of ${JSON.stringify(find)} in ` +
          `${target.name || `bufnr ${target.bufnr}`}${saved ? "; written to disk" : ""}.`,
      );
    } catch (error) {
      return fail(error);
    }
  },
);

server.registerTool(
  "nvim_goto",
  {
    title: "Move a Neovim cursor",
    description: "Move the cursor in the live UI, opening the file first if needed.",
    inputSchema: {
      ...targetShape,
      line: z.number().int().positive(),
      col: z.number().int().positive().optional().describe("1-based column (default 1)."),
    },
  },
  async ({ path: file, bufnr: buf, line, col = 1 }) => {
    try {
      const target = await resolveBuffer({ path: file, bufnr: buf });
      await lua(
        `local buf, line, col = ...
         local win
         for _, w in ipairs(vim.api.nvim_list_wins()) do
           if vim.api.nvim_win_get_buf(w) == buf then win = w break end
         end
         if not win then
           vim.api.nvim_set_current_buf(buf)
           win = vim.api.nvim_get_current_win()
         else
           vim.api.nvim_set_current_win(win)
         end
         local maxline = vim.api.nvim_buf_line_count(buf)
         vim.api.nvim_win_set_cursor(win, { math.min(line, maxline), math.max(col - 1, 0) })
         vim.cmd("normal! zz")
         return true`,
        [target.bufnr, line, col],
      );
      return ok(`Cursor at ${line}:${col} in ${target.name || `bufnr ${target.bufnr}`}.`);
    } catch (error) {
      return fail(error);
    }
  },
);

server.registerTool(
  "nvim_save",
  {
    title: "Save a buffer",
    description: "Write a live buffer to disk (:write).",
    inputSchema: { ...targetShape },
  },
  async ({ path: file, bufnr: buf }) => {
    try {
      const target = await resolveBuffer({ path: file, bufnr: buf });
      await saveIfRequested(target.bufnr, true);
      return ok(`Wrote ${target.name || `bufnr ${target.bufnr}`}.`);
    } catch (error) {
      return fail(error);
    }
  },
);

server.registerTool(
  "nvim_notify",
  {
    title: "Notify the Neovim user",
    description: "Show a message in the live Neovim UI (vim.notify), e.g. to announce agent activity.",
    inputSchema: {
      message: z.string(),
      level: z.enum(["trace", "debug", "info", "warn", "error"]).optional(),
    },
  },
  async ({ message, level = "info" }) => {
    try {
      await lua(
        `local msg, level = ...
         vim.notify(msg, vim.log.levels[level:upper()] or vim.log.levels.INFO)
         return true`,
        [message, level],
      );
      return ok(`Notified Neovim: ${message}`);
    } catch (error) {
      return fail(error);
    }
  },
);

server.registerTool(
  "nvim_exec_lua",
  {
    title: "Execute Lua in Neovim",
    description:
      "Escape hatch: run Lua in the live Neovim. `...` receives args. Return values must be JSON-serialisable.",
    inputSchema: {
      code: z.string().describe("Lua chunk. Access arguments via `local a, b = ...`."),
      args: z.array(z.any()).optional(),
    },
  },
  async ({ code, args = [] }) => {
    try {
      const result = await lua(code, args);
      let text;
      try {
        text = JSON.stringify(result, null, 2);
      } catch {
        text = String(result);
      }
      return ok(text ?? "nil");
    } catch (error) {
      return fail(error);
    }
  },
);

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

const transport = new StdioServerTransport();
await server.connect(transport);
log("ready (stdio)");
