/*
 * Minimal repeatable HTTP contract smoke test for the PI gateway.
 * Usage: GW_BASE_URL=http://localhost:18090 GW_TOKEN=... node contract-smoke.mjs
 * It creates only random, test-owned resources and removes them in finally.
 */
import crypto from "node:crypto";

const baseUrl = (process.env.GW_BASE_URL || "http://localhost:18090").replace(/\/$/, "");
const token = process.env.GW_TOKEN;
if (!token) throw new Error("GW_TOKEN is required");
const headers = { "X-GW-Token": token };
const suffix = crypto.randomUUID();
const testDir = `/.eftik-contract-${suffix}`;
let sessionId;
let skillId;
let taskId;

async function request(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, { ...options, headers: { ...headers, ...(options.headers || {}) } });
  const text = await response.text();
  let body;
  try { body = text ? JSON.parse(text) : {}; } catch { body = text; }
  if (!response.ok) throw new Error(`${options.method || "GET"} ${path}: ${response.status} ${typeof body === "string" ? body : JSON.stringify(body)}`);
  return body;
}
function json(method, body) { return { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }; }
function assert(condition, message) { if (!condition) throw new Error(message); }

try {
  const anonymous = await fetch(`${baseUrl}/health`);
  assert(anonymous.status === 401, "health must require X-GW-Token");
  const health = await request("/health");
  assert(health.runtime === "pi", "health runtime must be pi");

  const session = await request("/sessions", json("POST", { title: "contract smoke" }));
  sessionId = session.id;
  assert((await request(`/sessions/${sessionId}`)).title === "contract smoke", "session readback failed");

  await request(`/files/upload?path=${encodeURIComponent(`${testDir}/a.txt`)}`, { method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: "contract" });
  await request("/files/move", json("POST", { source: `${testDir}/a.txt`, target: `${testDir}/b.txt` }));
  const download = await fetch(`${baseUrl}/files/download?path=${encodeURIComponent(`${testDir}/b.txt`)}`, { headers });
  assert(download.ok && await download.text() === "contract", "file move/download failed");

  const skill = await request("/skills", json("POST", { name: "contract smoke", prompt: "test" }));
  skillId = skill.id;
  const updatedSkill = await request(`/skills/${skillId}`, json("PUT", { enabled: false }));
  assert(updatedSkill.enabled === false, "skill update failed");

  const task = await request("/tasks", json("POST", { name: "contract smoke", prompt: "test", enabled: false, schedule: { type: "interval", minutes: 60 } }));
  taskId = task.id;
  const updatedTask = await request(`/tasks/${taskId}`, json("PUT", { description: "contract" }));
  assert(updatedTask.description === "contract", "task update failed");

  console.log("PASS: gateway contract smoke");
} finally {
  const cleanup = (path, options) => request(path, options).catch(() => {});
  if (taskId) await cleanup(`/tasks/${taskId}`, { method: "DELETE" });
  if (skillId) await cleanup(`/skills/${skillId}`, { method: "DELETE" });
  if (sessionId) await cleanup(`/sessions/${sessionId}`, { method: "DELETE" });
  await cleanup(`/files?path=${encodeURIComponent(testDir)}&recursive=true`, { method: "DELETE" });
}
