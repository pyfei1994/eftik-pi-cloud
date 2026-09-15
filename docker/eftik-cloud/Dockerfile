FROM node:24-trixie

ARG PI_VERSION=0.85.1

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        tini git util-linux python3 python3-pip python3-venv \
        ripgrep poppler-utils pandoc \
        tesseract-ocr tesseract-ocr-chi-sim tesseract-ocr-eng \
        zip unzip p7zip-full tar gzip bzip2 xz-utils imagemagick \
    && rm -rf /var/lib/apt/lists/* \
    && python3 -m pip install --no-cache-dir --break-system-packages \
        python-docx==1.2.0 \
        python-pptx==1.0.2 \
        openpyxl==3.1.5 \
        XlsxWriter==3.2.9 \
        pypdf==6.1.3 \
        reportlab==4.4.3 \
        Markdown==3.9 \
        beautifulsoup4==4.14.0 \
        odfpy==1.4.1 \
        Pillow==12.1.0 \
        pytesseract==0.3.13 \
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
