/*
 * KitsuMe 运行时契约 e2e（PI/DSH 通用）
 *
 * 目的：补上「全量 HTTP/SSE 契约自动化测试」这块缺口。
 * 与 contract-smoke.mjs 的分工：
 *   - contract-smoke.mjs = 无模型依赖的纯 HTTP CRUD 冒烟（快，可进 CI 每次跑）
 *   - 本文件 = 依赖真实模型的端到端行为契约（慢，发版前跑）
 *
 * 覆盖的就是 API.md 里那些「换内核不许变」的东西：
 *   SSE 事件名与顺序、done 载荷字段、错误码枚举、取消语义、审批往返、usage 归一
 *
 * 用法：
 *   GW_BASE_URL=http://127.0.0.1:8090 GW_TOKEN=... node contract-e2e.mjs
 *   GW_BASE_URL=... GW_TOKEN=... node contract-e2e.mjs --quick   # 跳过耗时用例（取消/审批）
 */
import crypto from "node:crypto";
import http from "node:http";

const baseUrl = (process.env.GW_BASE_URL || "http://localhost:8090").replace(/\/$/, "");
const token = process.env.GW_TOKEN;
if (!token) throw new Error("GW_TOKEN is required");
const QUICK = process.argv.includes("--quick");

let pass = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) { pass++; console.log(`  \u2713 ${name}`); }
  else { failures.push(`${name}${detail ? " — " + detail : ""}`); console.log(`  \u2717 ${name}${detail ? " — " + detail : ""}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const J = (v) => { try { return JSON.stringify(v); } catch { return String(v); } };

async function api(method, path, body, raw) {
  const headers = { "X-GW-Token": token };
  let payload;
  if (body !== undefined) {
    if (raw) { headers["Content-Type"] = raw; payload = body; }
    else { headers["Content-Type"] = "application/json"; payload = JSON.stringify(body); }
  }
  const res = await fetch(`${baseUrl}${path}`, { method, headers, body: payload });
  const text = await res.text();
  let parsed; try { parsed = text ? JSON.parse(text) : {}; } catch { parsed = text; }
  return { status: res.status, body: parsed, text };
}

/** 读 SSE：收集事件直到 done/error，或用 onEvent 提前中断 */
function sse(taskId, onEvent, timeoutMs = 180000) {
  return new Promise((resolve) => {
    const events = [];
    const url = new URL(`${baseUrl}/task/${taskId}/stream`);
    const req = http.request({ hostname: url.hostname, port: url.port, path: url.pathname, headers: { "X-GW-Token": token } }, (res) => {
      let buf = "";
      const timer = setTimeout(() => { req.destroy(); resolve(events); }, timeoutMs);
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        buf += chunk;
        let idx;
        while ((idx = buf.indexOf("\n\n")) >= 0) {
          const block = buf.slice(0, idx); buf = buf.slice(idx + 2);
          const ev = (block.match(/^event: (.*)$/m) || [])[1];
          const dt = (block.match(/^data: (.*)$/m) || [])[1];
          if (!ev) continue;
          let data = {}; try { data = JSON.parse(dt); } catch {}
          events.push({ event: ev, data });
          if (onEvent) { try { onEvent(ev, data, events); } catch {} }
          if (ev === "done" || ev === "error") { clearTimeout(timer); req.destroy(); resolve(events); return; }
        }
      });
      res.on("end", () => { clearTimeout(timer); resolve(events); });
    });
    req.on("error", () => resolve(events));
    req.end();
  });
}

const USAGE_KEYS = ["inputTokens", "outputTokens", "totalTokens", "cacheReadTokens", "cacheWriteTokens", "reasoningTokens"];
// 网关层 SSE 事件白名单（注意：answer/error_code 是**网关层**的命名；
// chunk/errorCode 是中台再翻译一次后给小程序用的名字，别搞混）
const GW_EVENTS = ["answer", "thinking", "thinking_done", "log", "interaction", "interaction_resolved", "done"];

(async () => {
  console.log("=== 运行时契约 e2e ===");
  console.log(`base=${baseUrl} quick=${QUICK}\n`);

  /* ---------- 1. 鉴权与健康 ---------- */
  console.log("[1] 鉴权与 /health");
  const anon = await fetch(`${baseUrl}/health`);
  check("无令牌访问 /health 返回 401", anon.status === 401, `status=${anon.status}`);
  const h = await api("GET", "/health");
  check("/health 200", h.status === 200, `status=${h.status}`);
  check("/health 带 runtime 字段", typeof h.body.runtime === "string", J(h.body));
  check("/health 带 runtimeVersion", typeof h.body.runtimeVersion === "string", J(h.body.runtimeVersion));
  check("/health 带 engine_ready", typeof h.body.engine_ready === "boolean", J(h.body.engine_ready));
  const runtime = h.body.runtime;
  console.log(`  runtime=${runtime} version=${h.body.runtimeVersion} ready=${h.body.engine_ready}`);

  /* ---------- 2. 首轮对话：SSE 事件名 / 打字机 / done 载荷 ---------- */
  console.log("\n[2] 首轮对话（SSE 契约 + 打字机）");
  const c1 = await api("POST", "/chat", { message: "只回答两个字：收到" });
  check("POST /chat 返回 task_id", !!(c1.body && c1.body.task_id), J(c1.body));
  check("POST /chat 返回 session_id", !!(c1.body && c1.body.session_id), J(c1.body));
  const sid = c1.body.session_id;
  let answerDeltas = 0, thinkingDeltas = 0, logEvents = 0;
  const ev1 = await sse(c1.body.task_id, (ev) => {
    if (ev === "answer") answerDeltas++;
    else if (ev === "thinking") thinkingDeltas++;
    else if (ev === "log") logEvents++;
  });
  const names1 = ev1.map((e) => e.event);
  const done1 = ev1.find((e) => e.event === "done");
  const unknown1 = [...new Set(names1)].filter((n) => !GW_EVENTS.includes(n));
  check("SSE 事件名全在白名单内", unknown1.length === 0, unknown1.join(","));
  check("SSE 有 answer 增量（打字机）", answerDeltas > 0, `deltas=${answerDeltas}`);
  check("SSE 含 done", !!done1, names1.join(","));
  check("done.status=done", done1 && done1.data.status === "done", J(done1 && done1.data.status));
  check("done.reply 非空", !!(done1 && String(done1.data.reply || "").trim()), J(done1 && done1.data.reply));
  check("done 带 usage", !!(done1 && done1.data.usage), J(done1 && done1.data.usage));
  check("done 带 status 字段", !!(done1 && "status" in done1.data), J(done1 && Object.keys(done1.data)));
  check("done 带 error_code 字段", !!(done1 && "error_code" in done1.data), J(done1 && Object.keys(done1.data)));
  check("done 带 elapsed_ms 字段", !!(done1 && "elapsed_ms" in done1.data), J(done1 && Object.keys(done1.data)));
  check("done 带 error_detail 字段", !!(done1 && "error_detail" in done1.data), J(done1 && Object.keys(done1.data)));
  if (done1 && done1.data.usage) {
    const missing = USAGE_KEYS.filter((k) => !(k in done1.data.usage));
    check("usage 六字段归一齐全", missing.length === 0, missing.length ? "缺 " + missing.join(",") : "");
    check("usage 不伪造 token 数（数值或 null）",
      USAGE_KEYS.every((k) => done1.data.usage[k] === null || typeof done1.data.usage[k] === "number"),
      J(done1.data.usage));
  }
  console.log(`  reply=${J(String(done1 && done1.data.reply).slice(0, 60))} usage=${J(done1 && done1.data.usage)}`);

  /* ---------- 3. 多轮同会话 ---------- */
  console.log("\n[3] 同会话第二轮");
  const c2 = await api("POST", "/chat", { message: "我刚才让你回答什么？", sessionId: sid });
  check("第二轮受理", c2.status === 200 && !!c2.body.task_id, J(c2.body));
  check("session_id 复用", c2.body.session_id === sid, `${c2.body.session_id} vs ${sid}`);
  const ev2 = await sse(c2.body.task_id);
  const done2 = ev2.find((e) => e.event === "done");
  check("第二轮正常结束", done2 && done2.data.status === "done", J(done2 && done2.data));
  const reply2 = String((done2 && done2.data.reply) || "");
  check("第二轮有上下文（提到「收到」）", /收到/.test(reply2), J(reply2.slice(0, 80)));
  console.log(`  reply=${J(reply2.slice(0, 80))}`);

  /* ---------- 4. 任务查询接口形状 ---------- */
  console.log("\n[4] GET /task/{id} 形状");
  const t = await api("GET", `/task/${c1.body.task_id}`);
  check("GET /task 200", t.status === 200, `status=${t.status}`);
  for (const k of ["status", "reply", "error", "error_code", "usage"]) {
    check(`/task 含 ${k}`, t.body && k in t.body, J(t.body && Object.keys(t.body)));
  }

  /* ---------- 5. 入参守卫 ---------- */
  console.log("\n[5] 入参守卫");
  const tooLong = await api("POST", "/chat", { message: "x".repeat(200001) });
  check("超长消息被 4xx 拦下", tooLong.status >= 400 && tooLong.status < 500, `status=${tooLong.status}`);
  const noMsg = await api("POST", "/chat", {});
  check("空消息被 4xx 拦下", noMsg.status >= 400 && noMsg.status < 500, `status=${noMsg.status}`);

  /* ---------- 6. 工具可观测（SSE log） ---------- */
  console.log("\n[6] 工具可观测（SSE log）");
  const c3 = await api("POST", "/chat", { message: "用 shell 工具执行 echo contract-e2e 然后告诉我输出" });
  let sawLog = 0;
  const ev3 = await sse(c3.body.task_id, (ev, d) => { if (ev === "log") sawLog++; });
  const done3 = ev3.find((e) => e.event === "done");
  check("执行工具的任务正常结束", done3 && ["done", "failed"].includes(done3.data.status), J(done3 && done3.data.status));
  check("SSE 下发 log 事件（工具可观测）", sawLog > 0, `log=${sawLog}`);
  console.log(`  log 事件数=${sawLog}`);

  if (!QUICK) {
    /* ---------- 7. 取消语义 ---------- */
    console.log("\n[7] 取消（原生中断 + 保留已产出正文）");
    const c4 = await api("POST", "/chat", { message: "写一篇 3000 字的关于秋天景色的散文，直接开始写，不要问我任何问题" });
    check("长任务受理", !!c4.body.task_id, J(c4.body));
    await sleep(10000);
    const mid = await api("GET", `/task/${c4.body.task_id}`);
    console.log(`  取消前: status=${mid.body.status}`);
    const del = await api("DELETE", `/task/${c4.body.task_id}`);
    check("DELETE /task/{id} 成功", del.status === 200, J(del.body));
    await sleep(8000);
    const after = await api("GET", `/task/${c4.body.task_id}`);
    check("终态为 cancelled", after.body.status === "cancelled", J(after.body.status));
    check("error_code=CANCELLED", after.body.error_code === "CANCELLED", J(after.body.error_code));
    check("取消不算失败（error 为空）", !after.body.error, J(after.body.error));
    check("已产出正文被保留", String(after.body.reply || "").length > 0, `len=${String(after.body.reply || "").length}`);
    console.log(`  取消后: ${J({ status: after.body.status, error_code: after.body.error_code, replyLen: String(after.body.reply || "").length })}`);

    /* ---------- 8. 工作区外操作：遵循 PI 哲学（无权限门，容器即边界） ---------- */
    console.log("\n[8] 工作区外操作（无权限门，容器即边界）");
    // 用 /tmp（node 用户可写）而不是 /etc（root 所有，会因 OS 权限失败而混淆结论）
    const outsidePath = `/tmp/eftik-contract-${crypto.randomUUID()}.txt`;
    const c5 = await api("POST", "/chat", { message: `用 shell 工具把 hello 写入 ${outsidePath}，然后告诉我结果` });
    let sawInteraction = 0, sawBash = 0;
    const ev5 = await sse(c5.body.task_id, (ev, d) => {
      if (ev === "interaction") sawInteraction++;
      if (ev === "log" && /bash|shell/i.test(JSON.stringify(d))) sawBash++;
    }, 240000);
    const done5 = ev5.find((e) => e.event === "done");
    check("未弹出任何审批 interaction（pi 哲学：无权限门）", sawInteraction === 0, `interaction=${sawInteraction}`);
    check("回合正常收尾", done5 && ["done", "failed"].includes(done5.data.status), J(done5 && done5.data.status));
    check("确实调用了 shell 工具", sawBash > 0, `log匹配=${sawBash}`);
    console.log(`  目标文件（容器内验证）: ${outsidePath}`);
    console.log(`  outside_path=${outsidePath}`);
  }

  /* ---------- 9. 设置可选项 ---------- */
  console.log("\n[9] /settings/options");
  const so = await api("GET", "/settings/options");
  check("/settings/options 200", so.status === 200, `status=${so.status}`);
  const sbody = so.body || {};
  const hasLists = Array.isArray(sbody.models) || Array.isArray(sbody.modelGroups) || Array.isArray(sbody.permissions) || Array.isArray(sbody.presets);
  check("返回可选项列表", hasLists, J(Object.keys(sbody)));
  console.log(`  keys=${J(Object.keys(sbody))}`);

  console.log(`\n===== 契约 e2e：${pass} 通过 / ${failures.length} 失败 =====`);
  if (failures.length) {
    console.log("\n失败明细：");
    failures.forEach((f, i) => console.log(`  ${i + 1}. ${f}`));
  }
  process.exit(failures.length ? 1 : 0);
})().catch((e) => { console.error("!! 未捕获:", e && e.stack || e); process.exit(2); });
