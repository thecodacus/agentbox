FROM node:20-slim

ENV DEBIAN_FRONTEND=noninteractive
ENV DISPLAY=:99

RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium \
    xvfb \
    x11vnc \
    novnc \
    websockify \
    fluxbox \
    procps \
    gosu \
    && rm -rf /var/lib/apt/lists/*

ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

RUN useradd -m -s /bin/bash sandbox
WORKDIR /home/sandbox/app

COPY package.json .
RUN npm install --production

COPY server.js .
COPY start.sh .
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x start.sh /entrypoint.sh

# Owned by the sandbox user so a fresh named volume mounted here inherits
# non-root ownership; the entrypoint fixes up pre-existing root-owned volumes.
RUN mkdir -p /workspace && chown -R sandbox:sandbox /workspace /home/sandbox

EXPOSE 6080 8080

# The entrypoint starts as root only to fix volume ownership, then drops
# privileges — Chromium and everything the agent drives run as uid 1000.
ENTRYPOINT ["/entrypoint.sh"]
CMD ["./start.sh"]
