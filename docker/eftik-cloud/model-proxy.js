#!/usr/bin/env node
// Root-owned loopback proxy. The upstream key never enters the PI/node user environment.
const http = require("node:http");
const https = require("node:https");
const key = process.env.MODEL_PROXY_UPSTREAM_API_KEY || "";
const host = process.env.MODEL_PROXY_UPSTREAM_HOST || "api.deepseek.com";
if (!key) throw new Error("MODEL_PROXY_UPSTREAM_API_KEY is required");
http.createServer((req, res) => {
  // PI 只需要模型目录和对话接口。若把任意路径转发，模型/脚本可借 loopback
  // 代理携带平台 Key 调用 /user/balance 等账户接口，虽拿不到 Key 也会泄露账户数据。
  const pathname = new URL(req.url || "/", "http://localhost").pathname;
  const allowed = (req.method === "GET" && pathname === "/models")
    || (req.method === "POST" && pathname === "/chat/completions");
  if (!allowed) {
    res.writeHead(403, { "content-type": "application/json" });
    return res.end(JSON.stringify({ error: "model proxy route is not allowed" }));
  }
  const upstream = https.request({ hostname: host, port: 443, path: req.url, method: req.method,
    headers: { ...req.headers, host, authorization: `Bearer ${key}` } }, upstreamRes => {
      res.writeHead(upstreamRes.statusCode || 502, upstreamRes.headers); upstreamRes.pipe(res);
    });
  upstream.on("error", error => { res.writeHead(502, { "content-type": "application/json" }); res.end(JSON.stringify({ error: "model proxy unavailable" })); });
  req.pipe(upstream);
}).listen(8787, "127.0.0.1");
