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

### Manager resource limits

Sandboxes and deployments run code an LLM just wrote, so every container is capped.
Hitting the memory ceiling OOM-kills the container instead of dragging the host into
swap, and `PidsLimit` contains fork bombs. Override per environment:

| Variable | Default | Applies to |
|---|---|---|
| `SANDBOX_MEMORY_MB` | `1024` | shell sandboxes |
| `SANDBOX_CPUS` | `1` | shell sandboxes (fractional allowed, e.g. `0.5`) |
| `SANDBOX_PIDS_LIMIT` | `256` | shell sandboxes |
| `BROWSER_MEMORY_MB` | `3072` | browser sandboxes (Chromium + 2 GB `/dev/shm`) |
| `BROWSER_CPUS` | `2` | browser sandboxes |
| `BROWSER_PIDS_LIMIT` | `512` | browser sandboxes |
| `DEPLOYMENT_MEMORY_MB` | `512` | deployment containers |
| `DEPLOYMENT_CPUS` | `1` | deployment containers |
| `DEPLOYMENT_PIDS_LIMIT` | `128` | deployment containers |
