const express = require('express');
const Docker = require('dockerode');
const http = require('http');
const crypto = require('crypto');

const docker = new Docker({ socketPath: '/var/run/docker.sock' });
const app = express();
app.use(express.json());

// The manager holds the Docker socket, so reaching it is equivalent to
// controlling every container on the host. Sandboxes share agentbox-net with it
// and can therefore address it directly by container IP — publishing ports only
// on loopback does NOT protect against that. A shared secret does.
const MANAGER_TOKEN = process.env.MANAGER_TOKEN || '';

if (!MANAGER_TOKEN) {
  console.warn(
    '\n  WARNING: MANAGER_TOKEN is not set — the manager API is unauthenticated.\n' +
    '  Any container on agentbox-net (including sandboxes running LLM-written\n' +
    '  code) can spawn containers, start deployments and delete volumes.\n' +
    '  Generate one with:  openssl rand -hex 32\n'
  );
}

/** Constant-time compare so the token can't be recovered by timing the response. */
function tokensMatch(provided, expected) {
  const a = Buffer.from(String(provided));
  const b = Buffer.from(String(expected));
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

app.use((req, res, next) => {
  if (!MANAGER_TOKEN) return next(); // unauthenticated mode — warned about at boot
  if (req.path === '/health') return next();

  const header = req.get('authorization') || '';
  const provided = header.startsWith('Bearer ')
    ? header.slice(7)
    : req.get('x-agentbox-token') || '';

  if (!provided || !tokensMatch(provided, MANAGER_TOKEN)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
});

app.get('/health', (req, res) => res.json({ status: 'ok' }));

const SANDBOX_IMAGES = {
  browser: 'agentbox-sandbox',
  shell: 'agentbox-sandbox-shell',
};
const DEPLOYMENT_IMAGES = {
  static: 'python:3.12-alpine',
  node: 'node:20-alpine',
  python: 'python:3.12-alpine',
};
const NETWORK_NAME = 'agentbox-net';
const IDLE_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

// Docker volume name: letters/digits/underscore/dot/dash, must start alphanumeric.
// Rejects host paths (/, :, ..) so a malicious client can't bind-mount host dirs.
const VOLUME_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{1,254}$/;
function isValidVolumeName(name) {
  return typeof name === 'string' && VOLUME_NAME_RE.test(name);
}

async function pullImageIfMissing(image) {
  try {
    await docker.getImage(image).inspect();
    return; // already exists
  } catch {}
  await new Promise((resolve, reject) => {
    docker.pull(image, (err, stream) => {
      if (err) return reject(err);
      docker.modem.followProgress(stream, (e) => (e ? reject(e) : resolve()));
    });
  });
}

// Track sandboxes: id -> { container, apiPort, novncPort, createdAt, lastActivity, timer }
const sandboxes = new Map();

async function ensureNetwork() {
  try {
    await docker.getNetwork(NETWORK_NAME).inspect();
  } catch {
    await docker.createNetwork({ Name: NETWORK_NAME, Driver: 'bridge' });
  }
}

function resetIdleTimer(id) {
  const sb = sandboxes.get(id);
  if (!sb) return;
  sb.lastActivity = Date.now();
  if (sb.timer) clearTimeout(sb.timer);
  sb.timer = setTimeout(() => destroySandbox(id), IDLE_TIMEOUT_MS);
}

async function destroySandbox(id) {
  const sb = sandboxes.get(id);
  if (!sb) return;
  if (sb.timer) clearTimeout(sb.timer);
  try {
    await sb.container.stop({ t: 2 });
  } catch {}
  try {
    await sb.container.remove({ force: true });
  } catch {}
  sandboxes.delete(id);
  console.log(`Sandbox ${id} destroyed`);
}

async function waitForHealthUrl(baseUrl, retries = 30) {
  for (let i = 0; i < retries; i++) {
    try {
      await new Promise((resolve, reject) => {
        const req = http.get(`${baseUrl}/health`, (res) => {
          if (res.statusCode === 200) resolve();
          else reject();
        });
        req.on('error', reject);
        req.setTimeout(1000, () => { req.destroy(); reject(); });
      });
      return true;
    } catch {
      await new Promise(r => setTimeout(r, 1000));
    }
  }
  return false;
}

// Create sandbox
app.post('/sandboxes', async (req, res) => {
  try {
    const type = req.body.type || 'browser';
    const volume = req.body.volume || null;
    const image = SANDBOX_IMAGES[type];
    if (!image) return res.status(400).json({ error: `Invalid type: ${type}. Use "browser" or "shell"` });
    if (volume !== null && !isValidVolumeName(volume)) {
      return res.status(400).json({ error: 'Invalid volume name' });
    }

    await ensureNetwork();

    const isBrowser = type === 'browser';
    const MOUNT_TARGET = '/workspace';
    const containerConfig = {
      Image: image,
      HostConfig: {
        PublishAllPorts: true,
        NetworkMode: NETWORK_NAME,
        Binds: [],
      },
      ExposedPorts: { '8080/tcp': {} },
    };

    if (volume) {
      containerConfig.HostConfig.Binds.push(`${volume}:${MOUNT_TARGET}`);
    }

    if (isBrowser) {
      containerConfig.HostConfig.CapAdd = ['SYS_ADMIN'];
      containerConfig.HostConfig.ShmSize = 2 * 1024 * 1024 * 1024;
      containerConfig.ExposedPorts['6080/tcp'] = {};
    }

    const container = await docker.createContainer(containerConfig);
    await container.start();
    const info = await container.inspect();

    const ports = info.NetworkSettings.Ports;
    const novncPort = isBrowser ? ports['6080/tcp']?.[0]?.HostPort : null;
    const id = info.Id.slice(0, 12);

    const networkInfo = info.NetworkSettings.Networks[NETWORK_NAME];
    const containerIp = networkInfo?.IPAddress;
    const internalApiUrl = `http://${containerIp}:8080`;

    const sb = {
      container,
      type,
      volume: volume || null,
      internalApiUrl,
      novncPort: novncPort ? parseInt(novncPort) : null,
      createdAt: Date.now(),
      lastActivity: Date.now(),
      timer: null,
    };
    sandboxes.set(id, sb);
    resetIdleTimer(id);

    const healthy = await waitForHealthUrl(internalApiUrl);
    if (!healthy) {
      await destroySandbox(id);
      return res.status(500).json({ error: 'Sandbox failed to start' });
    }

    const result = { id, type };
    if (volume) result.workspace = MOUNT_TARGET;
    if (novncPort) result.ports = { novnc: parseInt(novncPort) };

    console.log(`Sandbox ${id} (${type}) created — internal: ${internalApiUrl}${novncPort ? `, noVNC: ${novncPort}` : ''}`);
    res.json(result);
  } catch (e) {
    console.error('Failed to create sandbox:', e);
    res.status(500).json({ error: e.message });
  }
});

// List sandboxes
app.get('/sandboxes', (req, res) => {
  const list = [];
  for (const [id, sb] of sandboxes) {
    const entry = {
      id,
      type: sb.type,
      createdAt: new Date(sb.createdAt).toISOString(),
      lastActivity: new Date(sb.lastActivity).toISOString(),
    };
    if (sb.novncPort) entry.ports = { novnc: sb.novncPort };
    list.push(entry);
  }
  res.json({ sandboxes: list });
});

// Get sandbox info
app.get('/sandboxes/:id', (req, res) => {
  const sb = sandboxes.get(req.params.id);
  if (!sb) return res.status(404).json({ error: 'Sandbox not found' });
  const result = {
    id: req.params.id,
    type: sb.type,
    ip: sb.ip,
    createdAt: new Date(sb.createdAt).toISOString(),
    lastActivity: new Date(sb.lastActivity).toISOString(),
  };
  if (sb.novncPort) result.ports = { novnc: sb.novncPort };
  res.json(result);
});

// Delete sandbox
app.delete('/sandboxes/:id', async (req, res) => {
  const sb = sandboxes.get(req.params.id);
  if (!sb) return res.status(404).json({ error: 'Sandbox not found' });
  await destroySandbox(req.params.id);
  res.json({ ok: true });
});

// Delete a named volume
app.delete('/volumes/:name', async (req, res) => {
  try {
    const volume = docker.getVolume(req.params.name);
    await volume.remove({ force: true });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- Deployments ---

app.post('/deployments', async (req, res) => {
  try {
    const { type, volume, workdir, command, ports } = req.body;
    const image = DEPLOYMENT_IMAGES[type];
    if (!image) return res.status(400).json({ error: `Invalid type: ${type}` });
    if (!volume) return res.status(400).json({ error: 'volume required' });
    if (!isValidVolumeName(volume)) return res.status(400).json({ error: 'Invalid volume name' });

    const portList = Array.isArray(ports) && ports.length > 0 ? ports : [8080];
    const mainPort = portList[0];
    const wd = workdir || '';

    let cmd;
    if (type === 'static') {
      cmd = `cd /workspace/${wd} && python -m http.server ${mainPort}`;
    } else if (type === 'node') {
      if (!command) return res.status(400).json({ error: 'command required for node' });
      cmd = `cd /workspace/${wd} && (npm install --silent 2>/dev/null || true) && ${command}`;
    } else if (type === 'python') {
      if (!command) return res.status(400).json({ error: 'command required for python' });
      cmd = `cd /workspace/${wd} && (pip install -r requirements.txt --quiet 2>/dev/null || true) && ${command}`;
    }

    console.log(`[Deploy] Pulling ${image}...`);
    await pullImageIfMissing(image);

    await ensureNetwork();

    const exposedPorts = {};
    for (const p of portList) exposedPorts[`${p}/tcp`] = {};

    const container = await docker.createContainer({
      Image: image,
      Cmd: ['sh', '-c', cmd],
      WorkingDir: '/workspace',
      ExposedPorts: exposedPorts,
      HostConfig: {
        Binds: [`${volume}:/workspace`],
        PublishAllPorts: true,
        NetworkMode: NETWORK_NAME,
      },
      Labels: { 'agentbox.deployment': 'true' },
    });
    await container.start();

    const info = await container.inspect();
    const publishedPorts = {};
    for (const p of portList) {
      const key = `${p}/tcp`;
      const hostPort = info.NetworkSettings.Ports[key]?.[0]?.HostPort;
      if (hostPort) publishedPorts[p] = parseInt(hostPort);
    }

    console.log(`[Deploy] Started container ${container.id.slice(0, 12)} published ${JSON.stringify(publishedPorts)}`);

    res.json({
      id: container.id.slice(0, 12),
      containerId: container.id,
      publishedPorts,
      status: 'running',
    });
  } catch (e) {
    console.error('[Deploy] Error:', e);
    res.status(500).json({ error: e.message });
  }
});

app.delete('/deployments/:id', async (req, res) => {
  try {
    const container = docker.getContainer(req.params.id);
    try { await container.stop({ t: 2 }); } catch {}
    try { await container.remove({ force: true }); } catch {}
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/deployments/:id/status', async (req, res) => {
  try {
    const container = docker.getContainer(req.params.id);
    const info = await container.inspect();
    res.json({ status: info.State.Status, running: info.State.Running });
  } catch (e) {
    res.status(404).json({ error: e.message });
  }
});

// Proxy all sandbox API requests
app.all('/sandboxes/:id/*', async (req, res) => {
  const sb = sandboxes.get(req.params.id);
  if (!sb) return res.status(404).json({ error: 'Sandbox not found' });

  resetIdleTimer(req.params.id);

  // Strip /sandboxes/:id prefix
  const path = req.originalUrl.replace(`/sandboxes/${req.params.id}`, '');
  const url = `${sb.internalApiUrl}${path}`;

  try {
    const headers = { 'Content-Type': 'application/json' };
    const options = { method: req.method, headers };
    if (['POST', 'PUT', 'PATCH'].includes(req.method) && req.body) {
      options.body = JSON.stringify(req.body);
    }

    const proxyRes = await fetch(url, options);

    // Forward content type
    const ct = proxyRes.headers.get('content-type');
    if (ct) res.set('Content-Type', ct);

    const buffer = Buffer.from(await proxyRes.arrayBuffer());
    res.status(proxyRes.status).send(buffer);
  } catch (e) {
    res.status(502).json({ error: `Proxy error: ${e.message}` });
  }
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Manager API listening on port ${PORT}`);
});

module.exports = { sandboxes, destroySandbox, resetIdleTimer, waitForHealthUrl };
