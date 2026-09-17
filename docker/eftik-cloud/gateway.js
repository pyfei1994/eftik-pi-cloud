"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const dns = require("node:dns").promises;
const net = require("node:net");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { createPiEngine } = require("./pi-engine");

const port = Number(process.env.GW_PORT || 8090);
let lastError = "";
let active;
const jobs = new Map();
let queue = Promise.resolve();
const sessionMapPath = process.env.GW_PI_SESSION_MAP_PATH || "/home/node/.pi/eftik-sessions.json";
const sessionMetadataPath = process.env.GW_SESSION_METADATA_PATH || "/home/node/.pi/eftik-session-metadata.json";
const settingsPath = process.env.GW_SETTINGS_PATH || "/home/node/.pi/eftik-settings.json";
const skillsPath = process.env.GW_SKILLS_PATH || "/home/node/.pi/eftik-skills.json";
const tasksPath = process.env.GW_TASKS_PATH || "/home/node/.pi/eftik-tasks.json";
const pluginsPath = process.env.GW_PLUGINS_PATH || "/home/node/.pi/eftik-plugins.json";
const execFileAsync = promisify(execFile);
const { GW_TOKEN: _pluginGatewayToken, MODEL_PROXY_UPSTREAM_API_KEY: _pluginModelKey, ...pluginInstallEnv } = process.env;
const maxDownloadBytes = Math.max(1, Number(process.env.GW_MAX_DOWNLOAD_MB) || 200) * 1024 * 1024;
const maxSkillArchiveBytes = Math.max(1, Number(process.env.GW_MAX_SKILL_ARCHIVE_MB) || 10) * 1024 * 1024;
const maxChatImages = 4;
const maxImageBase64Bytes = 7 * 1024 * 1024;
const maxTaskRuns = 100;
const jobRetentionMs = Math.max(1, Number(process.env.GW_JOB_RETENTION_HOURS) || 24) * 60 * 60 * 1000;
const supportedImageTypes = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
const sessionPaths = new Map();
let sessionMetadata = {};
try {
  const stored = JSON.parse(fs.readFileSync(sessionMapPath, "utf8"));
  for (const [id, path] of Object.entries(stored)) if (typeof path === "string") sessionPaths.set(id, path);
} catch (error) {
  if (error.code !== "ENOENT") console.warn(`[pi-gw] cannot read session map: ${error.message}`);
}
try { sessionMetadata = JSON.parse(fs.readFileSync(sessionMetadataPath, "utf8")).sessions || {}; } catch (error) {
  if (error.code !== "ENOENT") console.warn(`[pi-gw] cannot read session metadata: ${error.message}`);
}

function saveSessionPaths() {
  fs.mkdirSync(require("node:path").dirname(sessionMapPath), { recursive: true });
  fs.writeFileSync(sessionMapPath, JSON.stringify(Object.fromEntries(sessionPaths)), { mode: 0o600 });
}
function saveSessionMetadata() {
  fs.mkdirSync(path.dirname(sessionMetadataPath), { recursive: true });
  fs.writeFileSync(sessionMetadataPath, JSON.stringify({ sessions: sessionMetadata }), { mode: 0o600 });
}
function sessionSummary(record) {
  return { id: record.id, title: record.title, createdAt: record.createdAt, updatedAt: record.updatedAt, messageCount: record.messages.length, preview: record.preview || "" };
}
function ensureSession(id, title = "") {
  if (!sessionMetadata[id]) {
    const now = Date.now();
    sessionMetadata[id] = { id, title, createdAt: now, updatedAt: now, preview: "", messages: [] };
  }
  return sessionMetadata[id];
}
function appendSessionMessage(id, role, content) {
  const record = ensureSession(id);
  const now = Date.now();
  record.messages.push({ role, content, createdAt: now });
  record.updatedAt = now; record.preview = content.slice(0, 200);
  if (!record.title && role === "user") record.title = content.replace(/\s+/g, " ").slice(0, 40);
  saveSessionMetadata();
}
function loadSettings() { try { return JSON.parse(fs.readFileSync(settingsPath, "utf8")); } catch (error) { return {}; } }
function saveSettings(settings) { fs.mkdirSync(path.dirname(settingsPath), { recursive: true }); fs.writeFileSync(settingsPath, JSON.stringify(settings), { mode: 0o600 }); }
function loadSkills() { try { return JSON.parse(fs.readFileSync(skillsPath, "utf8")).skills || []; } catch (error) { return []; } }
function saveSkills(skills) { fs.mkdirSync(path.dirname(skillsPath), { recursive: true }); fs.writeFileSync(skillsPath, JSON.stringify({ skills }), { mode: 0o600 }); }
function skillDirectory(id) { return path.join(process.env.PI_CODING_AGENT_DIR || "/home/node/.pi/agent", "skills", id); }
function writeSkill(skill) {
  if (skill.installUrl) return; // 链接包自带 SKILL.md，不能被表单 prompt 覆盖。
  const directory = skillDirectory(skill.id);
  fs.mkdirSync(directory, { recursive: true });
  const content = `---\nname: ${JSON.stringify(skill.name)}\ndescription: ${JSON.stringify(skill.description || skill.name)}\n---\n\n${skill.prompt}\n`;
  fs.writeFileSync(path.join(directory, "SKILL.md"), content, { mode: 0o600 });
}
function isPrivateAddress(address) {
  if (net.isIPv4(address)) {
    const [a, b] = address.split(".").map(Number);
    return a === 10 || a === 127 || a === 0 || a >= 224 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  }
  const v = String(address).toLowerCase();
  return v === "::1" || v === "::" || v.startsWith("fc") || v.startsWith("fd") || v.startsWith("fe80:");
}
async function assertSafeSkillUrl(value) {
  const url = new URL(String(value || ""));
  if (url.protocol !== "https:" || url.username || url.password || url.port) throw new Error("技能包链接必须是公开 HTTPS 地址");
  const addresses = await dns.lookup(url.hostname, { all: true });
  if (!addresses.length || addresses.some(item => isPrivateAddress(item.address))) throw new Error("技能包链接不能指向内网地址");
  return url;
}
async function downloadSkillArchive(value, file) {
  let url = await assertSafeSkillUrl(value);
  for (let redirects = 0; redirects <= 3; redirects++) {
    const response = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(30000) });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const next = response.headers.get("location");
      if (!next || redirects === 3) throw new Error("技能包链接重定向次数过多");
      url = await assertSafeSkillUrl(new URL(next, url).toString());
      continue;
    }
    if (!response.ok || !response.body) throw new Error(`技能包下载失败（HTTP ${response.status}）`);
    const declared = Number(response.headers.get("content-length") || 0);
    if (declared > maxSkillArchiveBytes) throw new Error("技能包超过 10 MB 限制");
    const chunks = []; let total = 0;
    for await (const chunk of response.body) {
      total += chunk.length;
      if (total > maxSkillArchiveBytes) throw new Error("技能包超过 10 MB 限制");
      chunks.push(chunk);
    }
    fs.writeFileSync(file, Buffer.concat(chunks), { mode: 0o600 });
    return;
  }
}
async function installSkillPackage(skill, installUrl) {
  const tmp = path.join("/tmp", `pi-skill-${skill.id}-${crypto.randomUUID()}.zip`);
  const directory = skillDirectory(skill.id);
  try {
    await downloadSkillArchive(installUrl, tmp);
    await execFileAsync("python3", ["/opt/gw/skill-installer.py", tmp, directory], { timeout: 30000, maxBuffer: 64 * 1024 });
    const prompt = fs.readFileSync(path.join(directory, "SKILL.md"), "utf8");
    if (prompt.length > 100 * 1024) throw new Error("SKILL.md 超过 100 KB 限制");
    skill.installUrl = installUrl;
    skill.prompt = prompt;
  } finally { try { fs.unlinkSync(tmp); } catch {} }
}
function loadTasks() { try { return JSON.parse(fs.readFileSync(tasksPath, "utf8")).tasks || []; } catch (error) { return []; } }
function saveTasks(tasks) { fs.mkdirSync(path.dirname(tasksPath), { recursive: true }); fs.writeFileSync(tasksPath, JSON.stringify({ tasks }), { mode: 0o600 }); }
function trimTaskRuns(task) { task.runs = (task.runs || []).sort((left, right) => (right.finishedAt || right.at || 0) - (left.finishedAt || left.at || 0)).slice(0, maxTaskRuns); }
function loadPlugins() { try { return JSON.parse(fs.readFileSync(pluginsPath, "utf8")).plugins || []; } catch (error) { return []; } }
function savePlugins(plugins) { fs.mkdirSync(path.dirname(pluginsPath), { recursive: true }); fs.writeFileSync(pluginsPath, JSON.stringify({ plugins }), { mode: 0o600 }); }
function publicPlugin(item) {
  const { spec, ...safe } = item;
  return { ...safe, status: item.status || "installed", error: item.error || "" };
}
function verifiedPlatformPlugin(input) {
  if (!input || typeof input.id !== "string" || typeof input.name !== "string" || typeof input.spec !== "string" || typeof input.signature !== "string") return undefined;
  if (!/^[\w-]{1,64}$/.test(input.id) || !input.name.trim() || input.name.length > 100 || !input.spec.trim() || input.spec.length > 240) return undefined;
  const payload = `${input.id}\0${input.name}\0${input.spec}`;
  const expected = crypto.createHmac("sha256", process.env.GW_TOKEN || "").update(payload).digest("hex");
  const actualBuffer = Buffer.from(input.signature, "utf8");
  const expectedBuffer = Buffer.from(expected, "utf8");
  if (actualBuffer.length !== expectedBuffer.length || !crypto.timingSafeEqual(actualBuffer, expectedBuffer)) return undefined;
  return { id: input.id, name: input.name.trim(), spec: input.spec.trim() };
}
function recoverInterruptedTasks() {
  const tasks = loadTasks(); let changed = false;
  for (const task of tasks) {
    for (const run of task.runs || []) {
      if (run.status === "queued" || run.status === "running") {
        run.status = "failed"; run.error = "CONTAINER_RESTARTED"; changed = true;
      }
    }
    if (task.lastStatus === "queued" || task.lastStatus === "running") {
      task.lastStatus = "failed"; task.lastError = "CONTAINER_RESTARTED"; changed = true;
    }
  }
  if (changed) saveTasks(tasks);
}
recoverInterruptedTasks();

/**
 * 把内核/网络抛出的原始错误归到稳定错误码上。
 * ⚠️ 前端**只按 error_code 分流**，绝不匹配文案（文案会随上游变）。
 * 这里是「更完整的错误分类」的落地：PI 的失败消息是英文原文，不分类的话
 * 端上永远只看到通用的「执行失败」。
 */
function classifyError(raw) {
  const s = String((raw && raw.message) || raw || "");
  if (/ENOSPC|no space left/i.test(s)) return "WORKSPACE_FULL";
  if (/AUTH|401|403|api[\s_-]?key|unauthor|invalid token|credential/i.test(s)) return "MODEL_AUTH";
  if (/rate ?limit|429|too many requests|quota/i.test(s)) return "MODEL_RATE_LIMIT";
  if (/timeout|timed out/i.test(s)) return "TIMEOUT";
  if (/session.*not found|no such session/i.test(s)) return "SESSION_LOST";
  if (/KERNEL_NOT_READY|PI is not running|PI exited/i.test(s)) return "KERNEL_NOT_READY";
  return "MODEL_ERROR";
}

function finish(job, status, errorCode = "", error = "") {
  if (job.done) return;
  job.done = true;
  job.status = status;
  job.errorCode = errorCode;
  job.error = error;
  job.finishedAt = Date.now();
  job.events.push({ type: "done", data: {
    reply: job.reply,
    usage: job.usage,
    status,
    error_code: errorCode,
    error,
    // 与 DSH 网关对齐：elapsed_ms 供中台展示耗时，error_detail 留原始文案供排障
    elapsed_ms: job.finishedAt - job.createdAt,
    error_detail: error ? String(error).slice(0, 1000) : "",
  } });
  if (job.sessionId && status === "done" && job.reply) appendSessionMessage(job.sessionId, "assistant", job.reply);
  if (job.scheduledTaskId) {
    const tasks = loadTasks();
    const task = tasks.find((item) => item.id === job.scheduledTaskId);
    if (task) {
      task.lastStatus = status; task.lastError = error; task.lastRunAt = Date.now();
      task.runs ||= [];
      const run = task.runs.find((item) => item.id === job.id);
      if (run) { run.status = status; run.error = error; run.reply = job.reply; run.finishedAt = job.finishedAt; }
      else task.runs.unshift({ id: job.id, at: job.createdAt, finishedAt: job.finishedAt, status, error, reply: job.reply });
      trimTaskRuns(task);
      saveTasks(tasks);
    }
  }
  if (active === job) active = undefined;
  if (job.resolveCompletion) job.resolveCompletion();
}

/**
 * usage 归一：PI 报的是 {input,output,cacheRead,cacheWrite,reasoning,totalTokens,cost}，
 * 而中台/计费读的是 DSH 那套 {calls,inputTokens,outputTokens,totalTokens,cacheReadTokens,
 * cacheWriteTokens,reasoningTokens}。**不归一 = 计费静默算成 0**，是换内核最容易踩的坑。
 * 缺失字段一律 null，不伪造（契约要求）。
 * 注：PI 额外给了 cost，我们保留在 costUsd 里备用，不参与计费（平台自建口径）。
 */
function normalizeUsage(raw) {
  if (!raw || typeof raw !== "object") return null;
  const pick = (...vals) => { for (const v of vals) if (v != null) return v; return null; };
  return {
    calls: pick(raw.calls, 1),
    inputTokens: pick(raw.inputTokens, raw.input),
    outputTokens: pick(raw.outputTokens, raw.output),
    totalTokens: pick(raw.totalTokens),
    cacheReadTokens: pick(raw.cacheReadTokens, raw.cacheRead),
    cacheWriteTokens: pick(raw.cacheWriteTokens, raw.cacheWrite),
    reasoningTokens: pick(raw.reasoningTokens, raw.reasoning),
    costUsd: raw.cost ? pick(raw.cost.total) : null,
  };
}

/** 日志事件上限（与 DSH 一致），防止长任务把内存吃满 */
const MAX_EVENTS = 200;
/** /chat 正文长度硬上限（与 DSH 一致）：超限直接 400，不当成模型错误 */
const MAX_CHAT_CHARS = 200000;
/**
 * SSE 心跳间隔。长工具（装技能、装依赖、跑构建）期间内核可能连续几分钟不产生任何事件，
 * 而中间链路上的代理会按 idle timeout 掐掉这条「静默连接」——Sealos 入口 envoy 的
 * stream_idle_timeout 默认 300s，中台后端因此报 `工作台流式读取失败: closed`。
 * 心跳写成 SSE 注释行（以 `:` 开头），不构成事件，客户端解析器直接忽略，只负责续命。
 */
const SSE_HEARTBEAT_MS = 15000;

/** 推一条 log 事件（工具可观测；形状必须与 DSH 一致：{t,text}） */
function pushLog(job, text) {
  if (!job || job.events.length >= MAX_EVENTS) return;
  job.events.push({ type: "log", data: { t: Date.now(), text: String(text).slice(0, 300) } });
}

function enqueue(work) {
  const next = queue.then(work, work);
  queue = next.catch(() => {});
  return next;
}
function cleanupJobs() {
  const cutoff = Date.now() - jobRetentionMs;
  for (const [id, job] of jobs) if (job.done && job.finishedAt < cutoff) jobs.delete(id);
}
const jobCleanup = setInterval(cleanupJobs, 15 * 60 * 1000);
jobCleanup.unref();

const engine = createPiEngine({
  onExit: (error) => { lastError = error.message; if (active) finish(active, "failed", "KERNEL_NOT_READY", error.message); },
  onEvent: (event) => {
    if (!active) return;
    if (event.type === "message_update") {
      const delta = event.assistantMessageEvent || {};
      if (delta.type === "text_delta") {
        if (active.thinkingSeen && !active.thinkingFinished) { active.thinkingFinished = true; active.events.push({ type: "thinking_done", data: {} }); }
        active.reply += delta.delta || "";
        active.events.push({ type: "answer", data: { text: delta.delta || "", t: Date.now() } });
      }
      if (delta.type === "thinking_delta") { active.thinkingSeen = true; active.events.push({ type: "thinking", data: { text: delta.delta || "", t: Date.now() } }); }
      // usage 必须归一成 DSH 那套字段名，否则中台按新名字取不到值 → 计费静默归零
      if (event.usage) active.usage = normalizeUsage(event.usage);
    } else if (event.type === "message_end") {
      // 权威正文以 message_end 的完整消息为准（流式 delta 只负责实时渲染）：
      // 断线重连、粘包丢帧、retry 之后的正文都能在这里被纠正回来。
      //
      // ⚠️ message_end **对用户消息也会触发**。而我们把 systemPreamble 前置在了用户消息上，
      // 所以不加这道 role 判断的话，用户消息会把真正的回复覆盖掉 ——
      // 实测症状：回复里原样吐出 preamble 那段话。
      const message = event.message || {};
      if (message.role && message.role !== "assistant") return;
      const text = Array.isArray(message.content)
        ? message.content.filter((part) => part && part.type === "text").map((part) => part.text || "").join("")
        : (typeof message.content === "string" ? message.content : "");
      if (text) active.reply = text;
    } else if (event.type === "tool_execution_start") {
      // 工具可观测：中台与小程序会把 log 显示成「正在执行 xxx」
      pushLog(active, `执行工具 ${event.toolName || event.name || ""}`);
    } else if (event.type === "tool_execution_end") {
      pushLog(active, `工具 ${event.isError ? "失败" : "完成"} ${event.toolName || event.name || ""}`);
    } else if (event.type === "extension_ui_request") {
      active.interactions.set(event.id, event);
      active.events.push({ type: "interaction", data: event });
    } else if (event.type === "agent_settled") finish(active, "done");
  },
});
engine.start();

function startJob(message, sessionId, images, scheduledTaskId) {
  const job = { id: crypto.randomUUID(), createdAt: Date.now(), status: "queued", reply: "", usage: null, events: [], interactions: new Map(), error: "", errorCode: "", done: false, thinkingSeen: false, thinkingFinished: false, scheduledTaskId, sessionId: scheduledTaskId ? "" : sessionId };
  job.completion = new Promise((resolve) => { job.resolveCompletion = resolve; });
  jobs.set(job.id, job);
  void enqueue(async () => {
    if (job.done) return;
    active = job; job.status = "running";
    if (job.scheduledTaskId) {
      const tasks = loadTasks(); const task = tasks.find((item) => item.id === job.scheduledTaskId);
      if (task) { task.lastStatus = "running"; const run = (task.runs || []).find((item) => item.id === job.id); if (run) run.status = "running"; saveTasks(tasks); }
    }
    try {
      if (!engine.ready()) throw new Error("KERNEL_NOT_READY");
      if (sessionPaths.has(sessionId)) await engine.switchSession(sessionPaths.get(sessionId));
      else if (sessionPaths.size) await engine.newSession();
      if (!sessionPaths.has(sessionId)) { const state = await engine.state(); sessionPaths.set(sessionId, state.sessionFile); saveSessionPaths(); }
      const settings = loadSettings();
      // 模型由**中台统一配**（端上不暴露模型入口）。带图片的轮次必须走视觉模型，
      // 否则每次发图都会失败，而用户没有任何自救手段。
      const provider = settings.provider || "deepseek";
      const wanted = (images && images.length && settings.modelVision) ? settings.modelVision : settings.model;
      if (wanted) await engine.setModel(provider, wanted);
      if (settings.reasoning) await engine.setThinking(settings.reasoning);
      // system preamble（中台统一配置、下发到这里）：与 DSH 的 buildSystemPreamble 同一套路，
      // 作为上下文前缀随本轮一起发。没配就不加，避免污染普通对话。
      const preamble = typeof settings.systemPreamble === "string" ? settings.systemPreamble.trim() : "";
      const outgoing = preamble ? `${preamble}\n\n${message}` : message;
      console.log(`[pi-gw] turn model=${wanted || "(default)"}${images && images.length ? " (vision)" : ""} preamble=${preamble ? preamble.length + "字" : "无"}`);
      if (job.sessionId) appendSessionMessage(job.sessionId, "user", message);
      await engine.prompt(outgoing, images);
      await job.completion;
    } catch (error) { finish(job, "failed", classifyError(error), error.message); }
  });
  return job;
}

function due(task, now) {
  if (task.enabled === false || !task.schedule) return false;
  const schedule = task.schedule;
  const lastRunAt = task.lastRunAt || 0;
  if (schedule.type === "interval") return now - lastRunAt >= Math.max(1, Number(schedule.minutes) || 60) * 60000;
  const [hours, minutes] = String(schedule.time || "09:00").split(":").map(Number);
  const date = new Date(now);
  if (schedule.type === "weekly" && (!Array.isArray(schedule.days) || !schedule.days.includes(date.getDay()))) return false;
  const expected = new Date(date.getFullYear(), date.getMonth(), date.getDate(), hours, minutes, 0, 0).getTime();
  return now >= expected && lastRunAt < expected;
}

function runDueTasks() {
  const tasks = loadTasks();
  const task = tasks.find((item) => due(item, Date.now()));
  if (!task) return;
  task.lastRunAt = Date.now(); task.lastStatus = "queued";
  const job = startJob(task.prompt, `scheduled-${task.id}`, undefined, task.id);
  task.runs = [{ id: job.id, at: task.lastRunAt, status: "queued" }, ...(task.runs || [])]; trimTaskRuns(task);
  saveTasks(tasks);
}

const scheduler = setInterval(runDueTasks, 30000);
scheduler.unref();

function send(response, status, body) { response.writeHead(status, { "Content-Type": "application/json" }); response.end(JSON.stringify(body)); }
function readBody(request) { return new Promise((resolve, reject) => { let raw = ""; request.on("data", (chunk) => { raw += chunk; }); request.on("end", () => { try { resolve(JSON.parse(raw || "{}")); } catch { reject(new Error("invalid JSON")); } }); }); }
function readBytes(request, limit = 200 * 1024 * 1024) { return new Promise((resolve, reject) => { const chunks = []; let size = 0; request.on("data", (chunk) => { size += chunk.length; if (size > limit) { reject(new Error("file too large")); request.destroy(); } else chunks.push(chunk); }); request.on("end", () => resolve(Buffer.concat(chunks))); request.on("error", reject); }); }
function normalizeImages(input) {
  if (input == null) return [];
  if (!Array.isArray(input) || input.length > maxChatImages) throw new Error(`images must contain at most ${maxChatImages} items`);
  return input.map((image) => {
    if (!image || typeof image.data !== "string" || !supportedImageTypes.has(image.mimeType)) throw new Error("invalid image");
    const data = image.data.replace(/^data:[^;,]+;base64,/i, "");
    if (!data || data.length > maxImageBase64Bytes || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) throw new Error("invalid image data");
    return { type: "image", data, mimeType: image.mimeType };
  });
}
function validToken(request) {
  const expected = process.env.GW_TOKEN || "";
  const supplied = request.headers["x-gw-token"] || "";
  return Boolean(expected) && typeof supplied === "string" && supplied.length === expected.length
    && crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(expected));
}
function workspacePath(value) {
  const configuredRoot = path.resolve(process.env.GW_WORKDIR || "/workspace");
  const root = fs.realpathSync.native(configuredRoot);
  const target = path.resolve(root, `.${value || "/"}`);
  if (target !== root && !target.startsWith(`${root}${path.sep}`)) throw new Error("invalid workspace path");

  // Resolve the nearest existing ancestor. This also rejects a symlinked
  // directory or file that would otherwise escape the mounted workspace.
  let ancestor = target;
  while (!fs.existsSync(ancestor)) ancestor = path.dirname(ancestor);
  const realAncestor = fs.realpathSync.native(ancestor);
  if (realAncestor !== root && !realAncestor.startsWith(`${root}${path.sep}`)) throw new Error("workspace symlink escapes root");
  if (fs.existsSync(target)) {
    const realTarget = fs.realpathSync.native(target);
    if (realTarget !== root && !realTarget.startsWith(`${root}${path.sep}`)) throw new Error("workspace symlink escapes root");
  }
  return target;
}
function workspaceUsage(directory) {
  let total = 0;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const candidate = path.join(directory, entry.name);
    const stat = fs.lstatSync(candidate);
    if (stat.isSymbolicLink()) continue;
    if (stat.isDirectory()) total += workspaceUsage(candidate);
    else if (stat.isFile()) total += stat.size;
  }
  return total;
}

const handleRequest = async (request, response) => {
  const url = new URL(request.url, "http://gateway");
  // ⚠️ 兼容两套路径前缀：DSH 时代是 web-ui.js 在 8080 上把 `/_eftik/api/*` 转发给网关 8090，
  // 中台调用方用的就是这个前缀。PI 去掉了 web-ui，所以**网关自己必须也认它**，
  // 否则中台打过来全是 404（实测踩过：容器内 /health 正常，公网 /_eftik/api/health 404）。
  // URL 的 pathname 有 setter，直接规范化最省事，下游路由代码全都不用改。
  if (url.pathname === "/_eftik/api" || url.pathname.startsWith("/_eftik/api/")) {
    url.pathname = url.pathname.slice("/_eftik/api".length) || "/";
  }
  if (!validToken(request)) return send(response, 401, { error: "invalid gateway token" });
  if (request.method === "GET" && url.pathname === "/health") {
    response.writeHead(engine.ready() ? 200 : 503, { "Content-Type": "application/json" });
    response.end(JSON.stringify({
      ok: engine.ready(), runtime: "pi", runtimeVersion: "0.85.1", version: "gateway/pi-p2", jobs: jobs.size,
      engine_ready: engine.ready(), ...(lastError ? { error: lastError } : {}),
    }));
    return;
  }
  if (request.method === "POST" && url.pathname === "/chat") {
    try {
      const input = await readBody(request);
      const images = normalizeImages(input.images);
      if ((typeof input.message !== "string" || !input.message.trim()) && !images.length) return send(response, 400, { error: "message or images is required" });
      // 正文长度硬上限（与 DSH 网关一致）：超限是调用方的错，直接 400，
      // 不要放进去让模型调用失败 —— 那样会被归成 MODEL_ERROR，前端看不出真因。
      if (typeof input.message === "string" && input.message.length > MAX_CHAT_CHARS) {
        return send(response, 400, { error: `message 过长（上限 ${MAX_CHAT_CHARS} 字符）` });
      }
      const sessionId = typeof input.sessionId === "string" && input.sessionId ? input.sessionId : crypto.randomUUID();
      const job = startJob(typeof input.message === "string" ? input.message.trim() : "请描述这张图片。", sessionId, images);
      return send(response, 200, { task_id: job.id, session_id: sessionId });
    } catch (error) { return send(response, 400, { error: error.message }); }
  }
  if (request.method === "GET" && url.pathname === "/files") {
    try {
      const directory = workspacePath(url.searchParams.get("path") || "/");
      if (!fs.statSync(directory).isDirectory()) return send(response, 400, { error: "not a directory" });
      const entries = fs.readdirSync(directory, { withFileTypes: true }).map((entry) => {
        const stat = fs.lstatSync(path.join(directory, entry.name));
        return { name: entry.name, type: entry.isDirectory() ? "dir" : "file", size: entry.isDirectory() ? 0 : stat.size, mtime: stat.mtimeMs };
      }).sort((left, right) => (left.type === right.type ? left.name.localeCompare(right.name) : left.type === "dir" ? -1 : 1));
      return send(response, 200, { path: url.searchParams.get("path") || "/", entries });
    } catch (error) { return send(response, error.code === "ENOENT" ? 404 : 400, { error: error.message }); }
  }
  if (request.method === "GET" && url.pathname === "/storage") {
    try {
      const requestedPath = url.searchParams.get("path") || "/workspace";
      const directory = requestedPath === "/workspace" ? (process.env.GW_WORKDIR || "/workspace")
        : requestedPath === "/home/node/.pi" ? "/home/node/.pi" : undefined;
      if (!directory) return send(response, 400, { error: "unsupported storage path" });
      const stat = fs.statfsSync(directory);
      const totalBytes = Number(stat.blocks) * Number(stat.bsize);
      const freeBytes = Number(stat.bavail) * Number(stat.bsize);
      const usedBytes = workspaceUsage(directory);
      return send(response, 200, { path: requestedPath, usedBytes, totalBytes, freeBytes, usedPct: totalBytes ? Math.round(usedBytes * 10000 / totalBytes) / 100 : 0 });
    } catch (error) { return send(response, 500, { error: error.message }); }
  }
  if (request.method === "POST" && url.pathname === "/files/upload") {
    try {
      const target = workspacePath(url.searchParams.get("path"));
      const bytes = await readBytes(request);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, bytes, { mode: 0o600 });
      return send(response, 200, { path: url.searchParams.get("path"), size: bytes.length });
    } catch (error) { return send(response, error.message === "file too large" ? 413 : 400, { error: error.message }); }
  }
  if (request.method === "POST" && url.pathname === "/files/mkdir") {
    try {
      const input = await readBody(request);
      if (!input || typeof input.path !== "string" || !input.path.trim()) return send(response, 400, { error: "path is required" });
      const root = fs.realpathSync.native(path.resolve(process.env.GW_WORKDIR || "/workspace"));
      const target = workspacePath(input.path);
      if (target === root) return send(response, 400, { error: "cannot create workspace root" });
      if (fs.existsSync(target)) return send(response, 409, { error: "path already exists" });
      fs.mkdirSync(target, { recursive: false, mode: 0o700 });
      return send(response, 200, { ok: true, path: input.path });
    } catch (error) { return send(response, error.code === "EEXIST" ? 409 : 400, { error: error.message }); }
  }
  if (request.method === "GET" && url.pathname === "/files/download") {
    try {
      const target = workspacePath(url.searchParams.get("path"));
      const stat = fs.statSync(target);
      if (!stat.isFile()) return send(response, 400, { error: "not a file" });
      if (stat.size > maxDownloadBytes) return send(response, 400, { error: "file too large" });
      const filename = path.basename(target).replace(/[\\\r\n"]/g, "_");
      response.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Length": stat.size, "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(filename)}` });
      return fs.createReadStream(target).pipe(response);
    } catch (error) { return send(response, error.code === "ENOENT" ? 404 : 400, { error: error.message }); }
  }
  if (request.method === "DELETE" && url.pathname === "/files") {
    try {
      const root = fs.realpathSync.native(path.resolve(process.env.GW_WORKDIR || "/workspace"));
      const target = workspacePath(url.searchParams.get("path"));
      if (target === root) return send(response, 400, { error: "cannot delete workspace root" });
      const stat = fs.lstatSync(target);
      if (stat.isDirectory()) {
        if (url.searchParams.get("recursive") !== "true") return send(response, 400, { error: "recursive=true is required to delete a directory" });
        fs.rmSync(target, { recursive: true, force: false });
      } else fs.unlinkSync(target);
      return send(response, 200, { ok: true });
    } catch (error) { return send(response, error.code === "ENOENT" ? 404 : 400, { error: error.message }); }
  }
  if (request.method === "POST" && url.pathname === "/files/move") {
    try {
      const input = await readBody(request);
      if (typeof input.source !== "string" || typeof input.target !== "string") return send(response, 400, { error: "source and target are required" });
      const root = fs.realpathSync.native(path.resolve(process.env.GW_WORKDIR || "/workspace"));
      const source = workspacePath(input.source); const target = workspacePath(input.target);
      if (source === root || target === root) return send(response, 400, { error: "cannot move workspace root" });
      if (target === source || target.startsWith(`${source}${path.sep}`)) return send(response, 400, { error: "target cannot be inside source" });
      if (fs.existsSync(target)) {
        if (input.overwrite !== true) return send(response, 409, { error: "target already exists" });
        const existing = fs.lstatSync(target); fs.rmSync(target, { recursive: existing.isDirectory(), force: false });
      }
      fs.mkdirSync(path.dirname(target), { recursive: true }); fs.renameSync(source, target);
      return send(response, 200, { ok: true, path: input.target });
    } catch (error) { return send(response, error.code === "ENOENT" ? 404 : 400, { error: error.message }); }
  }
  if (request.method === "GET" && url.pathname === "/sessions") {
    return send(response, 200, { sessions: Object.values(sessionMetadata).map(sessionSummary).sort((left, right) => right.updatedAt - left.updatedAt) });
  }
  if (request.method === "POST" && url.pathname === "/sessions") {
    const input = await readBody(request);
    const id = crypto.randomUUID();
    const record = ensureSession(id, typeof input.title === "string" ? input.title.slice(0, 100) : ""); saveSessionMetadata();
    return send(response, 200, { id, title: record.title, createdAt: record.createdAt });
  }
  const sessionMatch = url.pathname.match(/^\/sessions\/([\w-]+)$/);
  if (sessionMatch && request.method === "GET") {
    const record = sessionMetadata[sessionMatch[1]];
    return record ? send(response, 200, { id: record.id, title: record.title, createdAt: record.createdAt, updatedAt: record.updatedAt, messages: record.messages }) : send(response, 404, { error: "session not found" });
  }
  if (sessionMatch && request.method === "DELETE") {
    const id = sessionMatch[1]; const sessionPath = sessionPaths.get(id);
    // ⚠️ 幂等：内核不认识这个会话（只在数据端留过档、或容器重建后 sessionPaths 已丢）
    // 也应视为「已删除」返回 200 —— 否则小程序/中台删会话会因为 not found 而整条失败。
    if (!sessionMetadata[id] && !sessionPath) return send(response, 200, { ok: true, noop: true });
    sessionPaths.delete(id); delete sessionMetadata[id]; saveSessionPaths(); saveSessionMetadata();
    if (sessionPath) {
      try { fs.unlinkSync(sessionPath); } catch (error) { if (error.code !== "ENOENT") throw error; }
    }
    return send(response, 200, { ok: true });
  }
  if (request.method === "GET" && url.pathname === "/settings") return send(response, 200, loadSettings());
  if (request.method === "POST" && url.pathname === "/settings") {
    try {
      const patch = await readBody(request);
      const settings = { ...loadSettings() };
      // 这些键由**中台统一下发**（工作台管理里配），端用户界面不暴露：
      //   provider/model      默认文本模型
      //   modelVision         视觉模型（带图片的轮次自动用它，见 startJob）
      //   reasoning           思考强度
      //   systemPreamble      全局人设与输出纪律，随每轮 prompt 前置
      for (const key of ["provider", "model", "modelVision", "reasoning", "systemPreamble"]) {
        if (typeof patch[key] === "string") settings[key] = patch[key];
      }
      saveSettings(settings);
      return send(response, 200, settings);
    } catch (error) { return send(response, 400, { error: error.message }); }
  }
  if (request.method === "DELETE" && url.pathname === "/settings") { saveSettings({}); return send(response, 200, {}); }
  // 目录由中台实时校验；运行时只接受使用本工作台 GW_TOKEN 签名的完整条目。
  if (request.method === "GET" && url.pathname === "/plugins") return send(response, 200, { plugins: loadPlugins().map(publicPlugin) });
  if (request.method === "POST" && url.pathname === "/plugins/install") {
    try {
      const input = await readBody(request); const approved = verifiedPlatformPlugin(input);
      if (!approved) return send(response, 403, { error: "插件安装授权无效" });
      if (active) return send(response, 409, { error: "当前有任务执行中，请稍后操作" });
      const plugins = loadPlugins(); const existing = plugins.find(item => item.id === approved.id);
      if (existing && (existing.status || "installed") === "installed") return send(response, 200, { ok: true, status: "installed" });
      if (existing && existing.status === "installing") return send(response, 202, { ok: true, status: "installing" });
      const record = { id: approved.id, name: approved.name || approved.id, spec: approved.spec, status: "installing", startedAt: Date.now(), error: "" };
      if (existing) Object.assign(existing, record); else plugins.push(record);
      savePlugins(plugins);
      // 下载 npm 包与重启内核都可能持续几十秒；先返回受理结果，端上轮询最终状态，
      // 避免整页被 wx.showLoading 锁死。
      void (async () => {
        try {
          await execFileAsync("pi", ["install", approved.spec], { cwd: process.env.PI_CODING_AGENT_DIR || "/home/node/.pi/agent", env: pluginInstallEnv, timeout: 120000, maxBuffer: 1024 * 1024 });
          // 只有新 PI 进程已启动后才对端上标记 installed，避免用户刚看到成功就去对话，
          // 但扩展尚未被新内核加载的竞态。
          await engine.restart(); lastError = "";
          const latest = loadPlugins(); const saved = latest.find(item => item.id === approved.id);
          if (saved) { saved.status = "installed"; saved.installedAt = Date.now(); saved.error = ""; delete saved.startedAt; savePlugins(latest); }
        } catch (error) {
          const latest = loadPlugins(); const saved = latest.find(item => item.id === approved.id);
          if (saved) { saved.status = "failed"; saved.error = String(error.stderr || error.message || "安装失败").slice(0, 400); savePlugins(latest); }
          console.warn(`[pi-gw] plugin install ${approved.id} failed: ${String(error.message || error)}`);
        }
      })();
      return send(response, 202, { ok: true, status: "installing" });
    } catch (error) { return send(response, 400, { error: `插件安装失败：${String(error.stderr || error.message).slice(0, 400)}` }); }
  }
  if (request.method === "POST" && url.pathname === "/plugins/remove") {
    try {
      const input = await readBody(request); const approved = verifiedPlatformPlugin(input);
      if (!approved) return send(response, 403, { error: "插件卸载授权无效" });
      if (active) return send(response, 409, { error: "当前有任务执行中，请稍后操作" });
      const plugins = loadPlugins(); const plugin = plugins.find(item => item.id === approved.id);
      if (!plugin) return send(response, 200, { ok: true, noop: true });
      await execFileAsync("pi", ["remove", plugin.spec], { cwd: process.env.PI_CODING_AGENT_DIR || "/home/node/.pi/agent", env: pluginInstallEnv, timeout: 120000, maxBuffer: 1024 * 1024 });
      savePlugins(plugins.filter(item => item.id !== approved.id)); await engine.restart(); lastError = ""; return send(response, 200, { ok: true });
    } catch (error) { return send(response, 400, { error: `插件卸载失败：${String(error.stderr || error.message).slice(0, 400)}` }); }
  }
  if (request.method === "GET" && url.pathname === "/settings/options") {
    try { return send(response, 200, { models: await engine.models(), current: loadSettings(), reasoning: ["off", "minimal", "low", "medium", "high", "xhigh", "max"] }); }
    catch (error) { return send(response, 503, { error: error.message }); }
  }
  if (request.method === "GET" && url.pathname === "/skills") return send(response, 200, { skills: loadSkills() });
  if (request.method === "POST" && url.pathname === "/skills") {
    try {
      const input = await readBody(request);
      if (typeof input.name !== "string" || !input.name.trim()) return send(response, 400, { error: "技能名称必填" });
      const installUrl = typeof input.installUrl === "string" ? input.installUrl.trim() : "";
      if (!installUrl && (typeof input.prompt !== "string" || !input.prompt.trim())) return send(response, 400, { error: "执行指令必填" });
      const skill = { id: crypto.randomUUID(), name: input.name.trim(), icon: typeof input.icon === "string" ? input.icon.slice(0, 32) : "", description: typeof input.description === "string" ? input.description.trim() : "", prompt: installUrl ? "" : input.prompt.trim(), enabled: input.enabled !== false, createdAt: Date.now(), updatedAt: Date.now() };
      if (installUrl) await installSkillPackage(skill, installUrl); else writeSkill(skill);
      const skills = loadSkills(); skills.unshift(skill); saveSkills(skills);
      return send(response, 200, skill);
    } catch (error) { return send(response, 400, { error: error.message }); }
  }
  const skillMatch = url.pathname.match(/^\/skills\/([\w-]+)$/);
  if (skillMatch && request.method === "PUT") {
    try {
      const input = await readBody(request); const skills = loadSkills(); const skill = skills.find((item) => item.id === skillMatch[1]);
      if (!skill) return send(response, 404, { error: "skill not found" });
      if (typeof input.name === "string") { if (!input.name.trim()) return send(response, 400, { error: "name must not be empty" }); skill.name = input.name.trim(); }
      const installUrl = typeof input.installUrl === "string" ? input.installUrl.trim() : "";
      if (installUrl) await installSkillPackage(skill, installUrl);
      else if (typeof input.prompt === "string") {
        if (!input.prompt.trim()) return send(response, 400, { error: "prompt must not be empty" });
        delete skill.installUrl; skill.prompt = input.prompt.trim(); writeSkill(skill);
      }
      if (typeof input.icon === "string") skill.icon = input.icon.slice(0, 32);
      if (typeof input.description === "string") skill.description = input.description.trim();
      if (typeof input.enabled === "boolean") skill.enabled = input.enabled;
      skill.updatedAt = Date.now(); saveSkills(skills); return send(response, 200, skill);
    } catch (error) { return send(response, 400, { error: error.message }); }
  }
  if (skillMatch && request.method === "DELETE") {
    const skills = loadSkills(); const index = skills.findIndex((skill) => skill.id === skillMatch[1]);
    if (index < 0) return send(response, 404, { error: "skill not found" });
    const [skill] = skills.splice(index, 1); saveSkills(skills);
    fs.rmSync(skillDirectory(skill.id), { recursive: true, force: true });
    return send(response, 200, { ok: true });
  }
  if (request.method === "GET" && url.pathname === "/tasks") return send(response, 200, { tasks: loadTasks() });
  if (request.method === "POST" && url.pathname === "/tasks") {
    try {
      const input = await readBody(request);
      if (typeof input.name !== "string" || typeof input.prompt !== "string" || !input.name.trim() || !input.prompt.trim() || !input.schedule) return send(response, 400, { error: "name, prompt and schedule are required" });
      const task = { id: crypto.randomUUID(), name: input.name.trim(), icon: typeof input.icon === "string" ? input.icon.slice(0, 32) : "", description: typeof input.description === "string" ? input.description.trim() : "", prompt: input.prompt.trim(), schedule: input.schedule, enabled: input.enabled !== false, lastRunAt: 0, lastStatus: "", lastError: "", runs: [], createdAt: Date.now(), updatedAt: Date.now() };
      const tasks = loadTasks(); tasks.unshift(task); saveTasks(tasks); return send(response, 200, task);
    } catch (error) { return send(response, 400, { error: error.message }); }
  }
  const taskMatch = url.pathname.match(/^\/tasks\/([\w-]+)$/);
  if (taskMatch && request.method === "PUT") {
    try {
      const input = await readBody(request); const tasks = loadTasks(); const task = tasks.find((item) => item.id === taskMatch[1]);
      if (!task) return send(response, 404, { error: "task not found" });
      if (typeof input.name === "string") { if (!input.name.trim()) return send(response, 400, { error: "name must not be empty" }); task.name = input.name.trim(); }
      if (typeof input.prompt === "string") { if (!input.prompt.trim()) return send(response, 400, { error: "prompt must not be empty" }); task.prompt = input.prompt.trim(); }
      if (typeof input.icon === "string") task.icon = input.icon.slice(0, 32);
      if (typeof input.description === "string") task.description = input.description.trim();
      if (input.schedule && typeof input.schedule === "object") task.schedule = input.schedule;
      if (typeof input.enabled === "boolean") task.enabled = input.enabled;
      task.updatedAt = Date.now(); saveTasks(tasks); return send(response, 200, task);
    } catch (error) { return send(response, 400, { error: error.message }); }
  }
  if (taskMatch && request.method === "DELETE") {
    const tasks = loadTasks(); const index = tasks.findIndex((task) => task.id === taskMatch[1]);
    if (index < 0) return send(response, 404, { error: "task not found" });
    tasks.splice(index, 1); saveTasks(tasks); return send(response, 200, { ok: true });
  }
  const taskRunMatch = url.pathname.match(/^\/tasks\/([\w-]+)\/run$/);
  if (taskRunMatch && request.method === "POST") {
    const task = loadTasks().find((item) => item.id === taskRunMatch[1]);
    if (!task) return send(response, 404, { error: "task not found" });
    try {
      const job = await startJob(task.prompt, `scheduled-${task.id}`, undefined, task.id);
      task.lastRunAt = Date.now(); task.lastStatus = "queued"; task.runs.unshift({ id: job.id, at: task.lastRunAt, status: "queued" }); trimTaskRuns(task); saveTasks(loadTasks().map((item) => item.id === task.id ? task : item));
      return send(response, 200, { task_id: job.id });
    } catch (error) { return send(response, error.message === "TASK_RUNNING" ? 409 : 500, { error: error.message }); }
  }
  const taskRunsMatch = url.pathname.match(/^\/tasks\/([\w-]+)\/runs$/);
  if (taskRunsMatch && request.method === "GET") {
    const task = loadTasks().find((item) => item.id === taskRunsMatch[1]);
    if (!task) return send(response, 404, { error: "task not found" });
    trimTaskRuns(task);
    const page = Math.max(1, Math.trunc(Number(url.searchParams.get("page")) || 1));
    const size = Math.min(20, Math.max(1, Math.trunc(Number(url.searchParams.get("size")) || 20)));
    const total = task.runs.length; const offset = (page - 1) * size;
    return send(response, 200, { taskId: task.id, lastStatus: task.lastStatus || "", lastRunAt: task.lastRunAt || 0, runs: task.runs.slice(offset, offset + size), total, hasMore: offset + size < total });
  }
  const taskRunDetailMatch = url.pathname.match(/^\/tasks\/([\w-]+)\/runs\/([\w-]+)$/);
  if (taskRunDetailMatch && request.method === "GET") {
    const task = loadTasks().find((item) => item.id === taskRunDetailMatch[1]);
    const run = task && (task.runs || []).find((item) => item.id === taskRunDetailMatch[2]);
    return run ? send(response, 200, run) : send(response, 404, { error: "task run not found" });
  }
  const match = url.pathname.match(/^\/task\/([\w-]+)(?:\/(stream))?$/);
  if (match) {
    const job = jobs.get(match[1]);
    if (!job) return send(response, 404, { error: "task not found" });
    if (request.method === "GET" && match[2] === "stream") {
      response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
      let cursor = 0;
      // 每次真正写出事件时刷新 lastWriteAt；静默超过 SSE_HEARTBEAT_MS 就补一行注释心跳，
      // 避免被中间代理按 idle timeout 断开（见 SSE_HEARTBEAT_MS 注释）。
      let lastWriteAt = Date.now();
      const timer = setInterval(() => {
        let wrote = false;
        while (cursor < job.events.length) {
          const event = job.events[cursor++];
          response.write(`event: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`);
          wrote = true;
        }
        if (wrote) { lastWriteAt = Date.now(); return; }
        if (job.done) { clearInterval(timer); response.end(); return; }
        if (Date.now() - lastWriteAt >= SSE_HEARTBEAT_MS) {
          response.write(`: ping ${Date.now()}\n\n`);
          lastWriteAt = Date.now();
        }
      }, 50);
      request.once("close", () => clearInterval(timer)); return;
    }
    if (request.method === "GET") return send(response, 200, {
      status: job.status, reply: job.reply, usage: job.usage, error: job.error, error_code: job.errorCode,
      pending_interactions: Array.from(job.interactions.values()),
    });
    if (request.method === "DELETE") {
      if (job.status === "queued") { finish(job, "cancelled", "CANCELLED"); return send(response, 200, { ok: true }); }
      if (job === active) {
        try { await engine.clearQueue(); finish(job, "cancelled", "CANCELLED"); await engine.abort(); return send(response, 200, { ok: true }); } catch (error) { return send(response, 500, { error: error.message }); }
      }
      return send(response, 409, { error: "task is already finished" });
    }
  }
  const interaction = url.pathname.match(/^\/task\/([\w-]+)\/interaction$/);
  if (interaction && request.method === "POST") {
    const job = jobs.get(interaction[1]);
    const input = await readBody(request);
    if (!job || !job.interactions.has(input.id)) return send(response, 404, { error: "interaction not found" });
    const uiRequest = job.interactions.get(input.id);
    try {
      let uiResponse;
      if (input.cancelled === true) uiResponse = { cancelled: true };
      else if (uiRequest.method === "confirm" && typeof input.confirmed === "boolean") uiResponse = { confirmed: input.confirmed };
      else if (["select", "input", "editor"].includes(uiRequest.method) && typeof input.value === "string") {
        if (uiRequest.method === "select" && (!Array.isArray(uiRequest.options) || !uiRequest.options.includes(input.value))) {
          return send(response, 400, { error: "selected value is not an offered option" });
        }
        uiResponse = { value: input.value };
      } else return send(response, 400, { error: "invalid interaction response" });
      engine.respondInteraction(input.id, uiResponse);
      job.interactions.delete(input.id);
      job.events.push({ type: "interaction_resolved", data: { id: input.id, ...uiResponse } });
      return send(response, 200, { ok: true });
    } catch (error) { return send(response, 500, { error: error.message }); }
  }
  send(response, 404, { error: "not found" });
};

// 监听 8090（本项目的约定端口）。
http.createServer(handleRequest).listen(port, "0.0.0.0",
  () => console.log(`[pi-gw] listening on ${port}`));

/**
 * ⚠️ 同时监听 8080：**Sealos 的 Service/Ingress 是按 8080 建的**（历史原因 ——
 * DSH 那版把 WebUI 放在 8080，平台的 Service 名就叫 `...-8080-...-service`）。
 * PI 镜像按产品决定去掉了 WebUI 那一层，于是 Service 把流量转到 8080 时容器里没人监听
 * → 上游永远不健康 → 公网恒定 503（实测：容器内 curl 8090 返回 401 完全正常，
 * 但外部 503，pod ready=true 且 0 重启）。这是「本地跑通、生产不通」的真正原因。
 *
 * 因此这里多绑一个 8080：平台侧零改动，新老工作台口径一致。
 * 设 GW_LEGACY_PORT=0 可关闭（若将来 Service 改成 8090）。
 */
const legacyPort = Number(process.env.GW_LEGACY_PORT ?? 8080);
if (legacyPort && legacyPort !== port) {
  http.createServer(handleRequest).listen(legacyPort, "0.0.0.0",
    () => console.log(`[pi-gw] also listening on ${legacyPort} (Sealos Service 端口)`));
}

process.on("SIGTERM", () => engine.stop());
