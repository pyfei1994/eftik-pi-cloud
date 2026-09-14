#!/bin/sh
# PI 运行时入口。
# ⚠️ chown 必须容错：Sealos 挂的 PVC 上 chown 可能失败（root squash / 存储驱动限制），
# 而 set -e 会让整个容器立刻退出 —— 表现就是「Pod 起来了又马上失败」。
# DSH 镜像一直是这么写的（`chown ... 2>/dev/null || true`），这里对齐。
set -eu
mkdir -p /home/node/.pi/agent /home/node/.pi/sessions /workspace 2>/dev/null || true
chown -R node:node /home/node/.pi /workspace 2>/dev/null || true
exec setpriv --reuid=node --regid=node --clear-groups node /opt/gw/gateway.js
