# instant-mcp

An MCP server that edits a **running** Neovim, so the agent's changes appear
live in the UI you already have open — and, if that Neovim is in an
[instant.nvim](https://github.com/ajmwagar/instant.nvim) session, in every other
connected client too.

```text
 agent / MCP client
        │  MCP (stdio)
        ▼
   instant-mcp ──msgpack-RPC──▶ your Neovim ──instant.nvim──▶ other clients
```

instant.nvim already handles fan-out and conflict resolution between editors.
This server only has to reach **one** live Neovim; instant does the rest. That
keeps the bridge small and means it also works with a plain Neovim that is not
sharing anything.

## Requirements

- Node.js 18+
- Neovim with a server socket. Modern Neovim creates one automatically
  (`v:servername`); you can also start one explicitly with `nvim --listen`.

## Install

```bash
cd mcp
npm install
```

## Run

```bash
node mcp/server.mjs            # discover a live Neovim socket
node mcp/server.mjs --socket /path/to/nvim.sock
node mcp/server.mjs --file NOTES.md   # only attach to an nvim that has NOTES.md open
```

The server speaks MCP over stdio. Logs go to stderr so they never corrupt the
protocol stream.

### Socket discovery

In order, it tries:

1. `--socket` / `INSTANT_MCP_NVIM` / `$NVIM` (set by Neovim for child processes)
2. Neovim's usual socket directories under `$TMPDIR`, `$XDG_RUNTIME_DIR`, `/tmp`,
   newest first
3. With `--file` / `INSTANT_MCP_FILE`, only sockets whose Neovim has that buffer

`nvim_status` reports which socket was chosen, so you can diagnose a wrong pick.

### Configure an MCP client

For [pi](https://pi.dev):

```bash
pi mcp add instant-nvim -- node /absolute/path/to/instant.nvim/mcp/server.mjs
```

or in `~/.pi/agent/mcp.json`:

```json
{
  "mcpServers": {
    "instant-nvim": {
      "command": "node",
      "args": ["/absolute/path/to/instant.nvim/mcp/server.mjs"],
      "description": "Read and edit the live Neovim buffer"
    }
  }
}
```

Claude Desktop / Cursor use the same `mcpServers` shape.

## Tools

| Tool | What it does |
| --- | --- |
| `nvim_status` | Socket, cwd, current buffer, cursor, mode, Instant username |
| `nvim_list_buffers` | Loaded buffers, line counts, modified state |
| `nvim_read` | Read a buffer range with 1-based line numbers |
| `nvim_open` | Show a file in the live UI, optionally move the cursor |
| `nvim_replace_lines` | Replace an inclusive 1-based line range |
| `nvim_insert_lines` | Insert lines before a 1-based line |
| `nvim_replace_text` | Literal or regex find/replace |
| `nvim_goto` | Move the human's cursor to a line/column |
| `nvim_save` | `:write` the buffer |
| `nvim_notify` | `vim.notify` in the live UI |
| `nvim_exec_lua` | Escape hatch: run arbitrary Lua in the live Neovim |

Most tools accept `path` (a full path or unique suffix) or `bufnr`, and default
to the current buffer. Edits are applied to the in-memory buffer; `save` is
`false` by default so the agent can propose changes that you review and `:w`
yourself. Pass `"save": true` or call `nvim_save` when you want them on disk.

## Using it with instant.nvim

1. In the Neovim you want to share, `:InstantStartServer` (or use an existing
   server) and `:InstantStartSingle`.
2. Other editors `:InstantJoinSingle`.
3. Start `instant-mcp` against the **local** Neovim socket.
4. Ask the agent to edit. The local buffer changes instantly; instant.nvim
   relays those changes to every other client.

If the agent runs on another machine, point the MCP server at the Neovim on
that machine that has joined the instant session. Only one editor needs to be
reachable over RPC.

## Notes and limits

- One Neovim per MCP server process; restart the client to switch sockets.
- The bridge edits buffers over RPC, it is not an instant.nvim CRDT peer. That
  is deliberate: your editor remains the source of truth.
- `nvim_replace_text` uses JavaScript regular-expression syntax when
  `regex: true`; literal mode is safe for arbitrary text.
- No daemon and no state: if Neovim restarts, the next tool call re-discovers a
  socket.
