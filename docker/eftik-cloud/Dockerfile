FROM node:24-trixie

ARG PI_VERSION=0.85.1

RUN apt-get update \
    && apt-get install -y --no-install-recommends tini git util-linux python3 \
    && rm -rf /var/lib/apt/lists/* \
    && npm install -g @earendil-works/pi-coding-agent@${PI_VERSION} \
    && pi --version

COPY gateway.js pi-engine.js model-proxy.js skill-installer.py entrypoint.sh /opt/gw/
RUN chmod 0755 /opt/gw/entrypoint.sh \
    && mkdir -p /home/node/.pi/agent /home/node/.pi/sessions /workspace \
    && chown -R node:node /home/node /workspace

ENV HOME=/home/node \
    GW_PORT=8090 \
    GW_WORKDIR=/workspace \
    PI_CODING_AGENT_DIR=/home/node/.pi/agent \
    PI_CODING_AGENT_SESSION_DIR=/home/node/.pi/sessions

EXPOSE 8090
ENTRYPOINT ["/usr/bin/tini", "--", "/opt/gw/entrypoint.sh"]
