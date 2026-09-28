#!/usr/bin/env node
// Root-owned loopback proxy. The upstream key never enters the Pi user environment.
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const https = require("node:https");

const key = process.env.MODEL_PROXY_UPSTREAM_API_KEY || "";
const host = process.env.MODEL_PROXY_UPSTREAM_HOST || "api.deepseek.com";
const gatewayToken = process.env.GW_TOKEN || "";
const apiBase = (process.env.KITSUME_API_BASE || "https://kitsume.eftik.com").replace(/\/+$/, "");
const spoolPath = process.env.MODEL_USAGE_SPOOL_PATH || "/home/node/.pi/.model-billing/pending.json";
if (!key || !gatewayToken) throw new Error("Model proxy credentials are required");

let pending = [];
try { pending = JSON.parse(fs.readFileSync(spoolPath, "utf8")); } catch (error) {
  if (error.code !== "ENOENT") throw error;
}
if (!Array.isArray(pending)) throw new Error("Invalid model usage spool");
let flushing = false;

function savePending() {
  const temporary = `${spoolPath}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(pending), { mode: 0o600 });
  fs.renameSync(temporary, spoolPath);
}

async function flushPending() {
  if (flushing || !pending.length) return;
  flushing = true;
  try {
    while (pending.length) {
      const response = await fetch(`${apiBase}/v1/workspace/model-usage`, {
        method: "POST",
        headers: { "content-type": "application/json", "X-GW-Token": gatewayToken },
        body: JSON.stringify(pending[0]),
        signal: AbortSignal.timeout(10000),
      });
      const result = await response.json();
      if (!response.ok || result.code !== 0) throw new Error(`usage report HTTP ${response.status}`);
      pending.shift();
      savePending();
    }
  } catch (error) {
    console.warn(`[model-proxy] usage report deferred: ${error.message}`);
  } finally { flushing = false; }
}

function recordUsage(message) {
  const usage = message && message.usage;
  const tokens = Number(usage && usage.total_tokens);
  if (!Number.isSafeInteger(tokens) || tokens <= 0) {
    console.warn("[model-proxy] response has no billable usage");
    return;
  }
  const requestId = typeof message.id === "string" && /^[\w-]{1,128}$/.test(message.id)
    ? message.id : crypto.randomUUID();
  if (pending.some(row => row.requestId === requestId)) return;
  pending.push({ requestId, totalTokens: tokens });
  savePending();
  void flushPending();
}

setInterval(() => { void flushPending(); }, 5000).unref();
void flushPending();

http.createServer((req, res) => {
  const pathname = new URL(req.url || "/", "http://localhost").pathname;
  const allowed = (req.method === "GET" && pathname === "/models")
    || (req.method === "POST" && pathname === "/chat/completions");
  if (!allowed) {
    res.writeHead(403, { "content-type": "application/json" });
    return res.end(JSON.stringify({ error: "model proxy route is not allowed" }));
  }
  const upstream = https.request({ hostname: host, port: 443, path: req.url, method: req.method,
    headers: { ...req.headers, host, authorization: `Bearer ${key}`, "accept-encoding": "identity" } }, upstreamRes => {
      let buffer = "";
      let lastUsage = null;
      const streaming = String(upstreamRes.headers["content-type"] || "").includes("text/event-stream");
      upstreamRes.on("data", chunk => {
        if (req.method !== "POST" || upstreamRes.statusCode !== 200) return;
        buffer += chunk.toString("utf8");
        if (!streaming) {
          if (buffer.length > 4 * 1024 * 1024) buffer = "";
          return;
        }
        let separator;
        while ((separator = /\r?\n\r?\n/.exec(buffer))) {
          const frame = buffer.slice(0, separator.index).replace(/\r/g, "");
          buffer = buffer.slice(separator.index + separator[0].length);
          for (const line of frame.split("\n")) {
            if (!line.startsWith("data:")) continue;
            try {
              const message = JSON.parse(line.slice(5).trim());
              if (message.usage) lastUsage = message;
            } catch { /* [DONE] and non-JSON frames */ }
          }
        }
        if (buffer.length > 1024 * 1024) buffer = buffer.slice(-1024 * 1024);
      });
      upstreamRes.once("end", () => {
        if (req.method !== "POST" || upstreamRes.statusCode !== 200) return;
        if (!streaming) {
          try { lastUsage = JSON.parse(buffer); } catch { /* malformed upstream response */ }
        }
        recordUsage(lastUsage);
      });
      res.writeHead(upstreamRes.statusCode || 502, upstreamRes.headers);
      upstreamRes.pipe(res);
    });
  upstream.on("error", () => { if (!res.headersSent) res.writeHead(502, { "content-type": "application/json" }); res.end(JSON.stringify({ error: "model proxy unavailable" })); });
  req.pipe(upstream);
}).listen(8787, "127.0.0.1");
