#!/bin/sh
set -eu
mkdir -p /home/node/.pi/agent /home/node/.pi/sessions /workspace
chown -R node:node /home/node/.pi /workspace
exec setpriv --reuid=node --regid=node --clear-groups node /opt/gw/gateway.js
