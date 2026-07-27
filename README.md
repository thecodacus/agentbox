# AgentBox

AI-powered sandbox environment. Chat with an LLM that can spawn ephemeral Docker containers to run code, browse the web, and deploy apps — all in isolated sandboxes.

## Features

- **Chat with sub-agents** — The main LLM delegates compute and browser tasks to sandboxed sub-agents
- **Shell agent** — Runs commands, creates/edits files, installs packages in a minimal Linux container
- **Browser agent** — Full Chromium with Playwright automation, live noVNC view to watch the agent work
- **Persistent workspaces** — Each chat has its own Docker volume at `/workspace`, files survive across agent invocations
- **Deploy apps** — Agents can deploy static/Node/Python apps from the workspace as running Docker containers
- **Background resilience** — Tasks continue server-side even if you close the browser tab
- **Chat history** — SQLite-backed persistence, resume chats from their URL

## Architecture

```
┌─────────────────────────────────────────┐
│  Next.js app (chat UI + APIs)           │
│  :3000                                  │
│  └─ SQLite (chats, sessions, deploys)   │
└──────────────┬──────────────────────────┘
               │
┌──────────────▼──────────────────────────┐
│  Manager (Express + dockerode)          │
│  :4000                                  │
│  Spawns sandboxes & deployments         │
└──────────────┬──────────────────────────┘
               │ Docker socket
      ┌────────┴────────┐
      │                 │
  Shell sandbox    Browser sandbox    Deployment containers
  (node:alpine)    (chromium+vnc)     (nginx, node, python)
```

## Quick Start

Prerequisites: Docker, Node.js 20+.

```bash
# 1. Build sandbox images
docker build -t agentbox-sandbox ./sandbox
docker build -t agentbox-sandbox-shell ./sandbox-shell

# 2. Start the manager
docker compose up -d

# 3. Configure and run the web app
cd app
cp .env.example .env.local
# Edit .env.local and add your OPENROUTER_API_KEY
npm install
npm run dev
```

Open http://localhost:3000 and start chatting.

## Project Structure

- `app/` — Next.js 16 chat UI + API routes
- `manager/` — Express service that manages Docker containers (sandboxes, deployments, volumes)
- `sandbox/` — Browser sandbox image (Chromium + Playwright + noVNC)
- `sandbox-shell/` — Shell sandbox image (lightweight Alpine with Node, Python, Git)
- `docker-compose.yml` — Manager service definition

## Environment

The app uses OpenRouter for LLM access. Get a key at https://openrouter.ai and put it in `app/.env.local`.

### Manager

| Variable | Default | Purpose |
|---|---|---|
| `BIND_HOST` | `127.0.0.1` | Host interface that sandbox noVNC and deployment ports are published on. Loopback by default so sandboxes aren't reachable from the rest of your network. Set to `0.0.0.0` only if you deliberately want LAN access. |

The sandbox control API (port 8080) is never published to the host — it is
unauthenticated and would grant command execution inside the sandbox to anyone who
can reach it. The manager talks to it over the internal Docker network instead.
