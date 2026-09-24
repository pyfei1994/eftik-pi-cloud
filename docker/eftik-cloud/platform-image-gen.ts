import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const API_BASE = (process.env.KITSUME_API_BASE || "https://kitsume.eftik.com").replace(/\/+$/, "");
const DATA_TOKEN = process.env.KITSUME_DATA_TOKEN || "";
const OUTPUT_DIR = process.env.PI_IMAGE_SAVE_DIR || "/workspace/generated-images";

function safeName(value: string): string {
  const cleaned = value.replace(/[^a-zA-Z0-9\u4e00-\u9fa5_-]+/g, "-").replace(/^-+|-+$/g, "");
  return (cleaned || "生成图片").slice(0, 24);
}

function compactStamp(now: Date): string {
  const two = (value: number): string => String(value).padStart(2, "0");
  return `${now.getFullYear()}${two(now.getMonth() + 1)}${two(now.getDate())}-${two(now.getHours())}${two(now.getMinutes())}${two(now.getSeconds())}`;
}

export default function platformImageGen(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "generate_image",
    label: "图片生成",
    description: "根据文字描述生成图片。平台自动选择可用供应商并按成功返回的图片张数扣除算力积分。",
    promptSnippet: "生成图片并保存到工作空间",
    promptGuidelines: ["用户要求生成、绘制或设计图片时，使用 generate_image。filename 使用 4 到 16 个字的简洁中文主题名，不要询问或索取 API Key。"],
    parameters: Type.Object({
      prompt: Type.String({ description: "完整、具体的图片描述" }),
      size: Type.Optional(Type.String({ description: "宽x高，例如 1024x1024、768x1024" })),
      n: Type.Optional(Type.Integer({ minimum: 1, maximum: 4, description: "生成张数，默认 1" })),
      filename: Type.Optional(Type.String({ description: "简短中文主题名，不含路径和扩展名，例如：月球吃香蕉的小狗" })),
    }),
    async execute(_toolCallId, params, signal) {
      if (!DATA_TOKEN) throw new Error("工作台图片服务令牌未配置");
      const response = await fetch(`${API_BASE}/v1/workspace/images/generations`, {
        method: "POST",
        headers: { Authorization: `Bearer ${DATA_TOKEN}`, "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: params.prompt, size: params.size, n: params.n || 1 }),
        signal: AbortSignal.any([signal, AbortSignal.timeout(660_000)]),
      });
      const raw = await response.text();
      let result: { data?: Array<{ url?: string; revised_prompt?: string }>; creditsUsed?: number; message?: string };
      try { result = JSON.parse(raw) as typeof result; }
      catch { throw new Error(`图片服务返回了无效响应（HTTP ${response.status}）`); }
      if (!response.ok || !result.data?.length) throw new Error(result.message || `图片生成失败（HTTP ${response.status}）`);

      await mkdir(OUTPUT_DIR, { recursive: true });
      const content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }> = [];
      const files: string[] = [];
      const imageLinks: string[] = [];
      for (let i = 0; i < result.data.length; i++) {
        const image = result.data[i];
        if (!image.url) continue;
        const downloaded = await fetch(image.url, { signal: AbortSignal.any([signal, AbortSignal.timeout(120_000)]) });
        if (!downloaded.ok) throw new Error(`生成成功但下载图片失败（HTTP ${downloaded.status}）`);
        const bytes = Buffer.from(await downloaded.arrayBuffer());
        const mimeType = (downloaded.headers.get("content-type") || "image/png").split(";", 1)[0];
        const ext = mimeType.includes("jpeg") ? "jpg" : mimeType.includes("webp") ? "webp" : "png";
        const stamp = compactStamp(new Date());
        const topic = safeName(params.filename || params.prompt);
        const sequence = String(i + 1).padStart(2, "0");
        const file = path.join(OUTPUT_DIR, `${topic}-${stamp}-${sequence}.${ext}`);
        await writeFile(file, bytes);
        files.push(file);
        imageLinks.push(`![生成图片 ${i + 1}](${image.url})`);
        content.push({ type: "image", data: bytes.toString("base64"), mimeType });
      }
      if (!files.length) throw new Error("图片服务未返回可下载的图片地址");
      content.unshift({ type: "text", text: [`已生成 ${files.length} 张图片并保存到工作空间：`, ...files.map((file) => `- ${file}`), "", ...imageLinks, "", `消耗：${result.creditsUsed || 0} 算力积分`].join("\n") });
      return { content, details: { files, urls: result.data.map((image) => image.url).filter(Boolean), creditsUsed: result.creditsUsed } };
    },
  });
}
