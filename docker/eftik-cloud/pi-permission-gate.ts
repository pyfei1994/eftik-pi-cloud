import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import path from "node:path";

/**
 * KitsuMe 权限门（PI 运行时）
 *
 * 策略与 DSH 对齐 —— DSH 在 workspace-write 档下，「写工作区外」是**弹审批让用户决定**
 * （实测：approval/request → allowed-once → 沙箱抬升 → 放行），不是硬拦。我们保留同一语义：
 *   1. 容器是用户自己的，「AI 要动工作区外的东西」应由用户拍板
 *   2. 产品上「AI 让用户选执行选项」是明确需求（小程序有审批卡片，走 interaction）
 * 硬拦只留给两种情况：不可逆命令、以及**危险操作但没有审批通道**（fail closed）。
 */

/** 需要用户确认的高风险命令（不是禁止） */
const NEEDS_REVIEW = /(^|\s)(rm\b|sudo\b|chmod\b|chown\b|mkfs\b|dd\b|curl\b|wget\b|nc\b|ssh\b|systemctl\b)/i;
/** 无论如何都拒绝：不可逆且明显破坏性，不给「手滑放行」的机会 */
const ALWAYS_DENY = /rm\s+-[a-z]*r[a-z]*\s+(\/|\/\*|~|\$HOME)(\s|$)|\b(mkfs(\.\w+)?|shutdown|reboot)\b|:\(\)\s*\{/i;
const workspaceRoot = "/workspace";

function resolveInside(value: unknown): boolean {
  if (typeof value !== "string" || !value.trim()) return false;
  const resolved = path.posix.resolve(workspaceRoot, value);
  return resolved === workspaceRoot || resolved.startsWith(`${workspaceRoot}/`);
}

/** bash 命令里是否出现越界路径（非 /workspace 的绝对路径、`..`、`~`） */
function escapesWorkspace(command: string): boolean {
  return /(^|[\s"'=])\/(?!workspace(?:\/|$))/.test(command)
    || /(^|[\s"'=])\.\.(?:\/|$)/.test(command)
    || /(^|[\s"'=])~(?:\/|$)/.test(command);
}

/** 统一审批出口：有 UI 通道就问用户；没有就 fail closed（手册 §7 要求） */
async function askOrBlock(ctx: any, title: string, detail: string) {
  if (!ctx.hasUI) return { block: true, reason: `${title}：当前没有用户审批通道，已按安全策略拒绝` };
  const approved = await ctx.ui.confirm(title, detail);
  return approved ? undefined : { block: true, reason: "用户拒绝了这次操作" };
}

export default function (pi: ExtensionAPI) {
  pi.on("tool_call", async (event: any, ctx: any) => {
    const command = String(event.input?.command ?? "");
    if (ALWAYS_DENY.test(command)) {
      return { block: true, reason: "该命令不可逆，已直接阻止" };
    }

    // 写/改工作区外 → 审批（与 DSH 同语义）
    if (["write", "edit"].includes(event.toolName) && !resolveInside(event.input?.path)) {
      return askOrBlock(
        ctx,
        "需要授权：写入工作区外",
        `AI 想写入工作区外的路径：\n\n${event.input?.path}\n\n仅本次放行，请确认。`,
      );
    }

    // 读工作区外不拦：读系统信息（/etc/os-release、command -v）是正常需求，风险极低
    if (event.toolName === "read") return undefined;
    if (event.toolName !== "bash") return undefined;

    if (escapesWorkspace(command)) {
      return askOrBlock(
        ctx,
        "需要授权：命令访问工作区外",
        `AI 想执行会访问 /workspace 之外的命令：\n\n${command}\n\n仅本次放行，请确认。`,
      );
    }
    if (NEEDS_REVIEW.test(command)) {
      return askOrBlock(ctx, "需要授权：高风险命令", `AI 想执行以下命令：\n\n${command}\n\n仅本次放行，请确认。`);
    }
    return undefined;
  });
}
