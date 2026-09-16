# Eftik PI Gateway API

运行时镜像内的 Node 网关，监听 `8090`，由 KitsuMe/Sealos 调用。PI 本体只通过 JSONL RPC
与网关通信；业务调用方不直接连接 `pi`。

当前版本：`gateway/pi-p1`，PI `0.85.1`。

## 1. 调用约定

所有接口都要求请求头：

```http
X-GW-Token: <GW_TOKEN>
```

令牌错误或缺失返回 `401`：

```json
{"error":"invalid gateway token"}
```

所有 JSON 接口使用 `application/json`。网关同时接受两种路径：

```text
/health
/_eftik/api/health
```

后者用于兼容 DSH 时代的中台调用；两者语义完全相同。

## 2. 健康检查

### `GET /health`

PI RPC 子进程就绪时返回 `200`，未就绪时返回 `503`。

```json
{
  "ok": true,
  "runtime": "pi",
  "runtimeVersion": "0.85.1",
  "version": "gateway/pi-p1",
  "jobs": 2,
  "engine_ready": true
}
```

若 PI 子进程最近一次退出，响应还会有 `error` 字段。

## 3. 对话与任务

### `POST /chat`

创建对话任务。任务先进入单工作台 FIFO 队列，返回时可能处于 `queued` 或很快变为
`running`。同一时刻只有一个 PI session 会被执行，避免跨会话串话。

请求：

```json
{
  "message": "帮我检查 workspace 里的文件",
  "sessionId": "可选的已有会话 ID",
  "images": [
    {"data":"base64-data","mimeType":"image/png","name":"可选，仅调用方显示"}
  ]
}
```

- `message` 或 `images` 至少提供一个；文字最多 `200000` 字符。
- 未提供 `sessionId` 时网关自动生成一个并在返回值中给出。
- 最多 4 张内联图，支持 `image/png`、`image/jpeg`、`image/webp`、`image/gif`；单图
  base64 字符串最多 7 MiB。可传 `data:image/...;base64,` 前缀。
- 如果设置了 `modelVision`，带图片的轮次自动切换到该模型。

返回：

```json
{"task_id":"uuid","session_id":"uuid"}
```

### `GET /task/{taskId}`

返回当前任务快照：

```json
{
  "status":"queued|running|done|failed|cancelled",
  "reply":"完整回复",
  "usage":{"calls":1,"inputTokens":1,"outputTokens":1,"totalTokens":2,
             "cacheReadTokens":null,"cacheWriteTokens":null,"reasoningTokens":null,"costUsd":null},
  "error":"",
  "error_code":"",
  "pending_interactions":[]
}
```

`usage` 可能为 `null`。PI 原始 usage 已归一为 DSH/KitsuMe 的字段名。

### `GET /task/{taskId}/stream`

SSE 流。每帧格式：

```text
event: answer
data: {"text":"增量正文","t":1730000000000}

```

支持的事件：

| 事件 | `data` | 说明 |
|---|---|---|
| `thinking` | `{text,t}` | 思考增量 |
| `thinking_done` | `{}` | 首段正文前的思考结束标记 |
| `answer` | `{text,t}` | 正文增量 |
| `log` | `{t,text}` | 工具开始/结束日志，最多保留 200 条事件 |
| `interaction` | PI 原始 extension UI 请求 | 等待用户确认/输入 |
| `interaction_resolved` | `{id,...response}` | 交互已答复 |
| `done` | 见下方 | 任务终态，随后流关闭 |

`done` 数据：

```json
{
  "reply":"完整回复",
  "usage":null,
  "status":"done|failed|cancelled",
  "error_code":"",
  "error":"",
  "elapsed_ms":1234,
  "error_detail":""
}
```

### `DELETE /task/{taskId}`

取消排队或正在运行的任务。成功返回 `{"ok":true}`；任务终态为
`cancelled`，错误码为 `CANCELLED`。已经结束的任务返回 `409`。

### `POST /task/{taskId}/interaction`

答复 PI extension 的未决交互。请求需带当前任务的交互 `id`。

```json
// confirm
{"id":"interaction-id","confirmed":true}

// select / input / editor
{"id":"interaction-id","value":"用户答案"}

// 任意对话交互取消
{"id":"interaction-id","cancelled":true}
```

`select` 的 `value` 必须是 PI 下发的 options 之一。成功返回 `{"ok":true}`。

## 4. 会话

会话元信息和网关记账的消息保存在 PVC；PI session 文件路径另行映射。列表按
`updatedAt` 倒序。

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/sessions` | 返回 `{sessions:[{id,title,createdAt,updatedAt,messageCount,preview}]}` |
| `POST` | `/sessions` | 请求可选 `{title}`，返回 `{id,title,createdAt}` |
| `GET` | `/sessions/{id}` | 返回会话及按时间正序的 `messages:[{role,content,createdAt}]` |
| `DELETE` | `/sessions/{id}` | 删除元信息与已知 PI session 文件，返回 `{ok:true}` |

首次 `/chat` 可惰性创建 session。对话成功后网关保存 user 和 assistant 消息；失败轮次不写 assistant 消息。

## 5. 工作区文件

所有路径都是 `/workspace` 下的虚拟绝对路径（例如 `/notes/a.txt`）。路径穿越、指向
工作区外的符号链接都会被拒绝。

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/files?path=/` | 列目录；目录优先、同类型按名称排序 |
| `GET` | `/storage?path=/workspace` | 返回工作区 `du` 语义的用量和文件系统容量；也可统计 `/home/node/.pi` |
| `POST` | `/files/upload?path=/a.txt` | 原始二进制 body 上传，最大 200 MiB |
| `GET` | `/files/download?path=/a.txt` | 二进制下载，最大值由 `GW_MAX_DOWNLOAD_MB` 控制，默认 200 MiB |
| `DELETE` | `/files?path=/a.txt` | 删除普通文件或符号链接 |
| `DELETE` | `/files?path=/dir&recursive=true` | 删除目录；目录必须显式 `recursive=true` |
| `POST` | `/files/move` | 移动/重命名 |

目录返回示例：

```json
{"path":"/","entries":[{"name":"notes","type":"dir","size":0,"mtime":1730000000000}]}
```

移动请求：

```json
{"source":"/old.txt","target":"/archive/new.txt","overwrite":false}
```

目标已存在时默认 `409`；仅 `overwrite:true` 才会替换。禁止删除或移动 `/workspace` 根目录，也禁止把目录移动进自身。

`GET /storage` 返回：

```json
{"path":"/workspace","usedBytes":12,"totalBytes":5368709120,"freeBytes":5368709108,"usedPct":0}
```

## 6. 设置

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/settings` | 读取已保存设置 |
| `POST` | `/settings` | 部分更新设置 |
| `DELETE` | `/settings` | 清空设置，返回 `{}` |
| `GET` | `/settings/options` | 返回 PI 可用模型、当前设置和 reasoning 枚举 |

`POST /settings` 可写字段：

```json
{
  "provider":"deepseek-official",
  "model":"文本模型 ID",
  "modelVision":"视觉模型 ID",
  "reasoning":"off|minimal|low|medium|high|xhigh|max",
  "systemPreamble":"由中台统一下发的系统前导"
}
```

这些字段属于工作台/中台配置，不应把模型提供方密钥暴露给端用户。

## 7. 技能

技能持久化在 PVC，同时生成 PI 原生 `SKILL.md`。

| 方法 | 路径 | 请求/说明 |
|---|---|---|
| `GET` | `/skills` | 返回 `{skills:[]}` |
| `POST` | `/skills` | `{name,prompt,icon?,description?,enabled?}`；`name` 和 `prompt` 必填 |
| `PUT` | `/skills/{id}` | 上述字段的部分更新 |
| `DELETE` | `/skills/{id}` | 删除记录和生成的目录 |

技能对象包含 `id,name,icon,description,prompt,enabled,createdAt,updatedAt`。

## 8. 定时任务

网关每 30 秒检查一次到期任务，并追加到与聊天共用的 FIFO。每个任务保留最近 100 条执行记录。

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/tasks` | 返回 `{tasks:[]}` |
| `POST` | `/tasks` | 创建；`name`、`prompt`、`schedule` 必填 |
| `PUT` | `/tasks/{id}` | 部分更新 |
| `DELETE` | `/tasks/{id}` | 删除 |
| `POST` | `/tasks/{id}/run` | 立即追加一次执行，返回 `{task_id}` |
| `GET` | `/tasks/{id}/runs?page=1&size=20` | 返回 `{runs,total,hasMore}`，每页最多 20 条 |
| `GET` | `/tasks/{id}/runs/{runId}` | 返回单条执行记录（含完整回复或错误） |

`schedule` 形态：

```json
{"type":"interval","minutes":60}
{"type":"daily","time":"09:30"}
{"type":"weekly","days":[1,2,3,4,5],"time":"09:30"}
```

`days` 使用 JavaScript 周日为 `0` 的约定。禁用任务传 `enabled:false`。容器重启时，原来
`queued/running` 的任务会被标记为 `failed`，错误为 `CONTAINER_RESTARTED`；网关不会自动重放，避免重复副作用。

## 9. 稳定错误码与生命周期

网关会尽力将 PI/网络原始错误归一为：

```text
CANCELLED, WORKSPACE_FULL, MODEL_AUTH, MODEL_RATE_LIMIT, TIMEOUT,
SESSION_LOST, KERNEL_NOT_READY, MODEL_ERROR, CONTAINER_RESTARTED
```

终态任务默认在内存中保留 24 小时；可用 `GW_JOB_RETENTION_HOURS` 调整。过期后查询
`/task/{id}` 返回 `404`，但定时任务的执行记录仍保存在 PVC。

## 10. 运行配置与限制

| 环境变量 | 默认值 | 用途 |
|---|---|---|
| `GW_TOKEN` | 无，必填 | 网关入站鉴权令牌 |
| `GW_PORT` | `8090` | HTTP 监听端口 |
| `GW_WORKDIR` | `/workspace` | 工作区/PVC 挂载目录 |
| `MODEL_PROXY_UPSTREAM_API_KEY` | 无 | 仅 root 权限的本地模型代理读取；不会传给 PI 或工具进程 |
| `GW_MAX_DOWNLOAD_MB` | `200` | 单文件下载上限 MiB |
| `GW_JOB_RETENTION_HOURS` | `24` | 终态 job 内存保留小时数 |
| `GW_PI_SESSION_MAP_PATH` | `/home/node/.pi/eftik-sessions.json` | 外部会话 ID 到 PI session 文件映射 |
| `GW_SESSION_METADATA_PATH` | `/home/node/.pi/eftik-session-metadata.json` | 会话元信息/消息记录 |
| `GW_SETTINGS_PATH` | `/home/node/.pi/eftik-settings.json` | 模型和系统前导设置 |
| `GW_SKILLS_PATH` | `/home/node/.pi/eftik-skills.json` | 技能记录 |
| `GW_TASKS_PATH` | `/home/node/.pi/eftik-tasks.json` | 定时任务记录 |

`GW_TOKEN` 与 `GW_ADMIN_TOKEN` 不会传入 PI 子进程；模型进程工作目录固定为 `/workspace`。

## 11. 已知未支持项

- 没有 DSH npm 插件安装/卸载 API；PI 插件能力仍待单独设计。
- 不提供用户自带模型密钥（BYOK）接口；模型密钥由 KitsuMe 平台配置并注入容器。
- bash 路径检查是保守规则，不替代完整 shell 解析或操作系统级沙箱。
- 任务 FIFO 是内存队列；重启时按前述规则标记失败，不恢复执行。

## 12. 回归脚本

`contract-smoke.mjs` 是基础 HTTP 冒烟测试。启动本地镜像后运行：

```powershell
$env:GW_BASE_URL = 'http://localhost:18090'
$env:GW_TOKEN = '本地容器的 GW_TOKEN'
node .\contract-smoke.mjs
```

脚本会覆盖鉴权、health、会话、文件移动/下载、技能和任务 CRUD，并清理自己创建的随机资源。
