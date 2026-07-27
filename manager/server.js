const express = require('express');
const Docker = require('dockerode');
const http = require('http');

const docker = new Docker({ socketPath: '/var/run/docker.sock' });
const app = express();
app.use(express.json());

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

// Capabilities are dropped wholesale and only these are handed back: enough for
// the image entrypoint to fix the mounted volume's ownership (CHOWN/DAC_OVERRIDE/
// FOWNER) and drop to the unprivileged user (SETUID/SETGID). Once it has dropped
// privileges the workload itself holds no capabilities at all.
//
// Notably absent: SYS_ADMIN. Chromium already launches with --no-sandbox, so it
// never needed the one capability most associated with container escapes.
const REQUIRED_CAPS = ['CHOWN', 'DAC_OVERRIDE', 'FOWNER', 'SETUID', 'SETGID'];

/** Capability + privilege-escalation hardening applied to every spawned container. */
function securityHardening() {
  return {
    CapDrop: ['ALL'],
    CapAdd: [...REQUIRED_CAPS],
    SecurityOpt: ['no-new-privileges'],
  };
}
// Resource caps for spawned containers. These run code an LLM just wrote, so an
// infinite loop, a memory balloon or a fork bomb is an ordinary Tuesday — without
// limits any of them takes the host down with it.
const MB = 1024 * 1024;
const num = (v, fallback) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : fallback);

const SANDBOX_MEMORY_MB = num(process.env.SANDBOX_MEMORY_MB, 1024);
// Chromium is heavy and its /dev/shm counts against the container's memory
// cgroup, so browser sandboxes get a higher ceiling than shell ones.
const BROWSER_MEMORY_MB = num(process.env.BROWSER_MEMORY_MB, 3072);
const SANDBOX_CPUS = num(process.env.SANDBOX_CPUS, 1);
const BROWSER_CPUS = num(process.env.BROWSER_CPUS, 2);
const SANDBOX_PIDS_LIMIT = num(process.env.SANDBOX_PIDS_LIMIT, 256);
const BROWSER_PIDS_LIMIT = num(process.env.BROWSER_PIDS_LIMIT, 512);
const DEPLOYMENT_MEMORY_MB = num(process.env.DEPLOYMENT_MEMORY_MB, 512);
const DEPLOYMENT_CPUS = num(process.env.DEPLOYMENT_CPUS, 1);
const DEPLOYMENT_PIDS_LIMIT = num(process.env.DEPLOYMENT_PIDS_LIMIT, 128);

/**
 * Docker resource limits. MemorySwap === Memory disables swap, so a container
 * that hits its ceiling is OOM-killed instead of dragging the host into swap.
 */
function resourceLimits(memoryMb, cpus, pidsLimit) {
  return {
    Memory: memoryMb * MB,
    MemorySwap: memoryMb * MB,
    NanoCpus: Math.round(cpus * 1e9),
    PidsLimit: pidsLimit,
  };
}
// Host interface published container ports bind to. Defaults to loopback so
// sandboxes and deployments are not reachable from the rest of the network.
// Set BIND_HOST=0.0.0.0 only if you deliberately want LAN access.
const BIND_HOST = process.env.BIND_HOST || '127.0.0.1';

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
    // The sandbox control API (8080) is deliberately NOT published: it is
    // unauthenticated, and the manager reaches it over the internal network by
    // container IP. Only noVNC is published, on the loopback interface.
    const containerConfig = {
      Image: image,
      HostConfig: {
        NetworkMode: NETWORK_NAME,
        Binds: [],
        ...securityHardening(),
        ...(isBrowser
          ? resourceLimits(BROWSER_MEMORY_MB, BROWSER_CPUS, BROWSER_PIDS_LIMIT)
          : resourceLimits(SANDBOX_MEMORY_MB, SANDBOX_CPUS, SANDBOX_PIDS_LIMIT)),
        PortBindings: {},
      },
      ExposedPorts: { '8080/tcp': {} },
    };

    if (volume) {
      containerConfig.HostConfig.Binds.push(`${volume}:${MOUNT_TARGET}`);
    }

    if (isBrowser) {
      // No SYS_ADMIN: Chromium runs with --no-sandbox, verified working without it.
      containerConfig.HostConfig.ShmSize = 2 * 1024 * 1024 * 1024;
      containerConfig.ExposedPorts['6080/tcp'] = {};
      // Empty HostPort => Docker picks a free port, as before.
      containerConfig.HostConfig.PortBindings['6080/tcp'] = [
        { HostIp: BIND_HOST, HostPort: '' },
      ];
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
    const portBindings = {};
    for (const p of portList) {
      exposedPorts[`${p}/tcp`] = {};
      portBindings[`${p}/tcp`] = [{ HostIp: BIND_HOST, HostPort: '' }];
    }

    const container = await docker.createContainer({
      Image: image,
      Cmd: ['sh', '-c', cmd],
      WorkingDir: '/workspace',
      ExposedPorts: exposedPorts,
      HostConfig: {
        Binds: [`${volume}:/workspace`],
        PortBindings: portBindings,
        NetworkMode: NETWORK_NAME,
        ...securityHardening(),
        ...resourceLimits(DEPLOYMENT_MEMORY_MB, DEPLOYMENT_CPUS, DEPLOYMENT_PIDS_LIMIT),
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
