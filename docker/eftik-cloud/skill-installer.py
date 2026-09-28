#!/usr/bin/env python3
"""Validate and extract a Skill ZIP into the Pi skills directory."""
import os
import json
import re
import shutil
import sys
import zipfile


def install(archive, destination):
    with zipfile.ZipFile(archive) as zf:
        entries = [item for item in zf.infolist() if not item.is_dir()]
        if not entries or len(entries) > 500:
            raise ValueError("技能包文件数量不合法（最多 500 个）")
        if sum(item.file_size for item in entries) > 50 * 1024 * 1024:
            raise ValueError("技能包解压后超过 50 MB 限制")
        safe_entries = []
        for item in entries:
            name = item.filename.replace("\\", "/")
            parts = name.split("/")
            mode = (item.external_attr >> 16) & 0o170000
            if (not name or name.startswith("/") or any(part in ("", ".", "..") for part in parts)
                    or ":" in parts[0] or "\x00" in name or len(name) > 512):
                raise ValueError("技能包路径不合法")
            if mode not in (0, 0o100000):
                raise ValueError("技能包不能包含符号链接或特殊文件")
            if "__MACOSX" in parts or parts[-1] in (".DS_Store", "Thumbs.db"):
                continue
            safe_entries.append((item, name))
        manifests = [name for _, name in safe_entries if name.split("/")[-1].lower() == "skill.md"]
        root_manifests = [name for name in manifests if "/" not in name]
        if len(root_manifests) == 1:
            chosen_manifest = root_manifests[0]
        elif len(manifests) == 1:
            chosen_manifest = manifests[0]
        else:
            raise ValueError("技能包必须且只能包含一个 SKILL.md")
        prefix = chosen_manifest.rsplit("/", 1)[0] + "/" if "/" in chosen_manifest else ""
        normalized = []
        seen = set()
        for item, original in safe_entries:
            if not original.startswith(prefix):
                continue
            name = original[len(prefix):]
            if name.lower() == "skill.md":
                name = "SKILL.md"
            if name in seen:
                raise ValueError("技能包路径重复")
            seen.add(name)
            normalized.append((item, name))
        staging = destination + ".staging"
        backup = destination + ".backup"
        shutil.rmtree(staging, ignore_errors=True)
        os.makedirs(staging, mode=0o700)
        try:
            for item, name in normalized:
                target = os.path.realpath(os.path.join(staging, name))
                if os.path.commonpath((os.path.realpath(staging), target)) != os.path.realpath(staging):
                    raise ValueError("技能包路径不合法")
                os.makedirs(os.path.dirname(target), exist_ok=True)
                with zf.open(item) as source, open(target, "wb") as output:
                    shutil.copyfileobj(source, output)
                executable = (item.external_attr >> 16) & 0o111
                os.chmod(target, 0o700 if executable else 0o600)
            manifest_file = os.path.join(staging, "SKILL.md")
            if os.path.getsize(manifest_file) > 100 * 1024:
                raise ValueError("SKILL.md 超过 100 KB 限制")
            with open(manifest_file, encoding="utf-8-sig") as manifest:
                content = manifest.read().replace("\r\n", "\n")
            if content.startswith("---"):
                closing = re.search(r"(?m)^---\s*$", content[3:])
                if not closing:
                    raise ValueError("SKILL.md 的 YAML 元数据没有结束标记")
                end = 3 + closing.start()
                header = content[3:end]
                body = content[end + len(closing.group()):]
            else:
                header = ""
                body = content
            description = re.search(r"(?mi)^description:\s*(\S.*)$", header)
            if not description or description.group(1).strip() in ('""', "''", "null", "~"):
                title = re.search(r"(?m)^#\s+(.+)$", body)
                slug = os.path.basename(destination).split("--")[-1]
                summary = (title.group(1).strip() if title else "Imported Skill " + slug)[:200]
                addition = "description: " + json.dumps(summary, ensure_ascii=False) + "\n"
                if header:
                    if description:
                        header = header[:description.start()] + addition.rstrip("\n") + header[description.end():]
                        content = "---" + header + "---" + body
                    else:
                        content = "---\n" + header.strip("\n") + "\n" + addition + "---" + body
                else:
                    content = "---\n" + addition + "---\n\n" + body
                with open(manifest_file, "w", encoding="utf-8") as output:
                    output.write(content)
            if os.path.exists(backup) and not os.path.exists(destination):
                os.replace(backup, destination)
            shutil.rmtree(backup, ignore_errors=True)
            if os.path.exists(destination):
                os.replace(destination, backup)
            try:
                os.replace(staging, destination)
            except Exception:
                if os.path.exists(backup):
                    os.replace(backup, destination)
                raise
            shutil.rmtree(backup, ignore_errors=True)
        finally:
            shutil.rmtree(staging, ignore_errors=True)


if __name__ == "__main__":
    install(sys.argv[1], sys.argv[2])
