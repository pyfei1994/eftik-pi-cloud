#!/bin/sh
# PI 运行时入口。
# ⚠️ chown 必须容错：Sealos 挂的 PVC 上 chown 可能失败（root squash / 存储驱动限制），
# 而 set -e 会让整个容器立刻退出 —— 表现就是「Pod 起来了又马上失败」。
# DSH 镜像一直是这么写的（`chown ... 2>/dev/null || true`），这里对齐。
set -eu
mkdir -p /home/node/.pi/agent /home/node/.pi/sessions /workspace 2>/dev/null || true
chown -R node:node /home/node/.pi /workspace 2>/dev/null || true
node /opt/gw/model-proxy.js &
proxy_pid=$!
trap 'kill "$proxy_pid" 2>/dev/null || true; exit 0' INT TERM
cat > /home/node/.pi/agent/models.json <<'EOF'
{"providers":{"deepseek":{"baseUrl":"http://127.0.0.1:8787","apiKey":"local-proxy"}}}
EOF
chown node:node /home/node/.pi/agent/models.json
unset MODEL_PROXY_UPSTREAM_API_KEY MODEL_PROXY_UPSTREAM_HOST DEEPSEEK_API_KEY
exec setpriv --reuid=node --regid=node --clear-groups node /opt/gw/gateway.js
