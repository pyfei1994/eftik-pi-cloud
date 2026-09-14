"use strict";

const { spawn } = require("node:child_process");
const { StringDecoder } = require("node:string_decoder");

function createPiEngine({ onEvent = () => {}, onExit = () => {} } = {}) {
  let child;
  let buffer = "";
  let nextId = 0;
  const pending = new Map();

  function rejectPending(error) {
    for (const { reject } of pending.values()) reject(error);
    pending.clear();
  }

  function handleLine(line) {
    if (!line) return;
    let message;
    try { message = JSON.parse(line); } catch { return; }
    if (message.type === "response" && message.id && pending.has(message.id)) {
      const request = pending.get(message.id);
      pending.delete(message.id);
      if (message.success) request.resolve(message.data);
      else request.reject(new Error(message.error || "PI RPC command failed"));
      return;
    }
    onEvent(message);
  }

  function start() {
    if (child && child.exitCode === null) return;
    const args = ["--mode", "rpc", "--session-dir", process.env.PI_CODING_AGENT_SESSION_DIR || "/home/node/.pi/sessions"];
    // The model may invoke `env` through bash. Gateway ingress credentials are
    // not needed by PI and must never enter that child process.
    const { GW_TOKEN: _gatewayToken, GW_ADMIN_TOKEN: _adminToken, ...piEnv } = process.env;
    child = spawn("pi", args, {
      cwd: process.env.GW_WORKDIR || "/workspace",
      env: piEnv,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const decoder = new StringDecoder("utf8");
    child.stdout.on("data", (chunk) => {
      buffer += decoder.write(chunk);
      for (;;) {
        const newline = buffer.indexOf("\n");
        if (newline < 0) break;
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        handleLine(line.endsWith("\r") ? line.slice(0, -1) : line);
      }
    });
    child.stderr.on("data", (chunk) => process.stderr.write(`[pi] ${chunk}`));
    // ⚠️ 必须有 error 监听：spawn 失败（ENOENT / 权限不足）会派发 'error' 事件，
    // 没有监听者时会变成未捕获异常 → **网关进程直接退出** → 容器失败重启。
    child.once("error", (error) => {
      rejectPending(error);
      onExit(error);
    });
    child.once("exit", (code, signal) => {
      const error = new Error(`PI exited (code=${code}, signal=${signal || "none"})`);
      rejectPending(error);
      onExit(error);
    });
  }

  function command(payload) {
    if (!child || child.exitCode !== null || !child.stdin.writable) {
      return Promise.reject(new Error("PI is not running"));
    }
    const id = `gw-${++nextId}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`PI command timed out: ${payload.type}`));
      }, 30000);
      pending.set(id, {
        resolve(value) { clearTimeout(timer); resolve(value); },
        reject(error) { clearTimeout(timer); reject(error); },
      });
      child.stdin.write(`${JSON.stringify({ ...payload, id })}\n`);
    });
  }

  function write(payload) {
    if (!child || child.exitCode !== null || !child.stdin.writable) {
      throw new Error("PI is not running");
    }
    child.stdin.write(`${JSON.stringify(payload)}\n`);
  }

  return {
    start,
    ready: () => Boolean(child && child.exitCode === null),
    prompt: (message, images) => command({ type: "prompt", message, ...(images ? { images } : {}) }),
    abort: () => command({ type: "abort" }),
    clearQueue: () => command({ type: "clear_queue" }),
    newSession: () => command({ type: "new_session" }),
    state: () => command({ type: "get_state" }),
    models: () => command({ type: "get_available_models" }).then((data) => data.models),
    setModel: (provider, modelId) => command({ type: "set_model", provider, modelId }),
    setThinking: (level) => command({ type: "set_thinking_level", level }),
    switchSession: (sessionPath) => command({ type: "switch_session", sessionPath }),
    sessionStats: () => command({ type: "get_session_stats" }),
    respondInteraction: (id, response) => write({ type: "extension_ui_response", id, ...response }),
    stop() { if (child && child.exitCode === null) child.kill("SIGTERM"); },
  };
}

module.exports = { createPiEngine };
