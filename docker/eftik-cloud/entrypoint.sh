#!/bin/sh
set -eu
mkdir -p /home/node/.pi/agent/extensions /home/node/.pi/sessions /workspace
cp /opt/gw/pi-permission-gate.ts /home/node/.pi/agent/extensions/pi-permission-gate.ts
chown -R node:node /home/node/.pi /workspace
exec setpriv --reuid=node --regid=node --clear-groups node /opt/gw/gateway.js
