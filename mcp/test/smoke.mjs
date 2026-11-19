#!/usr/bin/env node
/**
 * Smoke test: speaks MCP over stdio to server.mjs and exercises the read-only
 * tools against a live Neovim. Pass a socket path as argv[2], or let the server
 * discover one.
 *
 *   node test/smoke.mjs /path/to/nvim.sock
 */

import { spawn } from "node:child_process";
import process from "node:process";

const socket = process.argv[2];
const server = spawn(process.execPath, ["server.mjs"], {
  stdio: ["pipe", "pipe", "inherit"],
  env: socket ? { ...process.env, INSTANT_MCP_NVIM: socket } : process.env,
});

let nextId = 1;
const pending = new Map();
let buffer = "";

server.stdout.setEncoding("utf8");
server.stdout.on("data", (chunk) => {
  buffer += chunk;
  let i;
  while ((i = buffer.indexOf("\n")) !== -1) {
    const line = buffer.slice(0, i).trim();
    buffer = buffer.slice(i + 1);
    if (!line) continue;
    const message = JSON.parse(line);
    if (message.id && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) reject(new Error(JSON.stringify(message.error)));
      else resolve(message.result);
    }
  }
});

function request(method, params = {}) {
  const id = nextId++;
  const message = { jsonrpc: "2.0", id, method, params };
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    server.stdin.write(JSON.stringify(message) + "\n");
  });
}

function notify(method, params = {}) {
  server.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
}

const timeout = setTimeout(() => {
  console.error("smoke test timed out");
  server.kill("SIGKILL");
  process.exit(1);
}, 20000);

try {
  const init = await request("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "instant-mcp-smoke", version: "0.1.0" },
  });
  console.log("server:", init.serverInfo?.name, init.serverInfo?.version);
  notify("notifications/initialized");

  const tools = await request("tools/list");
  console.log("tools:", tools.tools.map((t) => t.name).join(", "));

  const status = await request("tools/call", { name: "nvim_status", arguments: {} });
  console.log("\n--- nvim_status ---\n" + status.content[0].text);

  const bufs = await request("tools/call", { name: "nvim_list_buffers", arguments: {} });
  console.log("\n--- nvim_list_buffers ---\n" + bufs.content[0].text);

  const read = await request("tools/call", {
    name: "nvim_read",
    arguments: { start: 1, end: 5 },
  });
  console.log("\n--- nvim_read (1-5) ---\n" + read.content[0].text);

  console.log("\nsmoke test ok");
  clearTimeout(timeout);
  server.stdin.end();
  server.kill("SIGTERM");
} catch (error) {
  clearTimeout(timeout);
  console.error("smoke test failed:", error.message);
  server.kill("SIGKILL");
  process.exit(1);
}
