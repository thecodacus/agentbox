FROM node:20-alpine

RUN apk add --no-cache \
    bash coreutils curl wget git \
    python3 py3-pip \
    procps htop \
    su-exec \
    && adduser -D -s /bin/bash sandbox

WORKDIR /home/sandbox/app

COPY package.json .
RUN npm install --production

COPY server.js .
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# Owned by the sandbox user so a fresh named volume mounted here inherits
# non-root ownership; the entrypoint fixes up pre-existing root-owned volumes.
RUN mkdir -p /workspace && chown -R sandbox:sandbox /workspace /home/sandbox

EXPOSE 8080

# The entrypoint starts as root only to fix volume ownership, then drops
# privileges — the server, and everything the agent runs, are uid 1000.
ENTRYPOINT ["/entrypoint.sh"]
CMD ["node", "server.js"]
