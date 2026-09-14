#!/usr/bin/env python3
"""Extract a user-supplied Skill archive after validating its contents."""
import os
import shutil
import sys
import zipfile

archive, destination = sys.argv[1], sys.argv[2]
MAX_FILES = 100
MAX_UNPACKED = 30 * 1024 * 1024
ALLOWED = ("SKILL.md", "scripts/", "assets/")

with zipfile.ZipFile(archive) as zf:
    entries = [item for item in zf.infolist() if not item.is_dir()]
    if not entries or len(entries) > MAX_FILES:
        raise ValueError("技能包文件数量不合法（最多 100 个）")
    if sum(item.file_size for item in entries) > MAX_UNPACKED:
        raise ValueError("技能包解压后超过 30 MB 限制")
    names = [item.filename.replace("\\", "/") for item in entries]
    # GitHub 的 archive/refs/heads/main.zip 通常多一层 repo-main/；安全地剥掉
    # 这一层后同样按固定白名单校验，方便用户直接粘贴 GitHub ZIP 链接。
    first_parts = {name.split("/", 1)[0] for name in names}
    prefix = ""
    if len(first_parts) == 1 and all("/" in name for name in names):
        prefix = next(iter(first_parts)) + "/"
    normalized = []
    for item, original in zip(entries, names):
        name = original[len(prefix):] if prefix else original
        # Avoid Zip Slip and reject symbolic links, executable payloads outside the approved tree,
        # and a nested arbitrary top-level directory.
        if name.startswith("/") or ".." in name.split("/") or not name.startswith(ALLOWED):
            raise ValueError("技能包仅允许 SKILL.md、scripts/ 和 assets/ 文件")
        if (item.external_attr >> 16) & 0o170000 == 0o120000:
            raise ValueError("技能包不能包含符号链接")
        normalized.append((item, name))
    if "SKILL.md" not in {name for _, name in normalized}:
        raise ValueError("技能包根目录必须包含 SKILL.md")
    staging = destination + ".staging"
    shutil.rmtree(staging, ignore_errors=True)
    os.makedirs(staging, mode=0o700)
    for item, name in normalized:
        target = os.path.realpath(os.path.join(staging, name))
        if not target.startswith(os.path.realpath(staging) + os.sep):
            raise ValueError("技能包路径不合法")
        os.makedirs(os.path.dirname(target), exist_ok=True)
        with zf.open(item) as source, open(target, "wb") as output:
            shutil.copyfileobj(source, output)
        os.chmod(target, 0o600)
    shutil.rmtree(destination, ignore_errors=True)
    os.rename(staging, destination)
