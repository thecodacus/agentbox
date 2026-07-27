const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { SSEServerTransport } = require('@modelcontextprotocol/sdk/server/sse.js');
const express = require('express');
const { z } = require('zod');

const MANAGER_URL = process.env.MANAGER_URL || 'http://localhost:4000';
const MANAGER_TOKEN = process.env.MANAGER_TOKEN || '';

// --- Session mode ---
//
// Handing this MCP to an agent should not hand it sandbox lifecycle management:
// every tool resolves to its session's sandbox automatically, and files under
// /workspace live in that session's volume. sandbox_id stays available for
// callers that genuinely want to manage sandboxes themselves.

// Two ways to scope a workspace, chosen by AGENTBOX_SESSION_MODE:
//
//   fixed           (default) — every connection shares one session id, so an
//                   agent reconnecting later comes back to the same workspace.
//                   This is what you want when handing the MCP to one agent.
//
//   per-connection  — each MCP connection gets its own isolated session, and its
//                   workspace is deleted when the connection closes. Use this to
//                   keep concurrent or untrusted clients from seeing each
//                   other's files.
const SESSION_MODE = (process.env.AGENTBOX_SESSION_MODE || 'fixed').toLowerCase();
const FIXED_SESSION_ID = process.env.AGENTBOX_SESSION_ID || 'default';

if (!['fixed', 'per-connection'].includes(SESSION_MODE)) {
  console.error(`[agentbox] unknown AGENTBOX_SESSION_MODE '${SESSION_MODE}', falling back to 'fixed'`);
}
const EPHEMERAL = SESSION_MODE === 'per-connection';

/**
 * Per-session state: which sandboxes are live and which volume holds the files.
 * One of these exists per connection in per-connection mode, or one shared
 * instance in fixed mode.
 */
function createSession(sessionId) {
  const volume = `agentbox-session-${sessionId}`;
  const sandboxes = new Map(); // type -> sandbox id
  const inFlight = new Map(); // type -> Promise, so parallel calls create only one

  async function isAlive(sandboxId) {
    try {
      const info = await managerFetch(`/sandboxes/${sandboxId}`);
      return Boolean(info && !info.error);
    } catch {
      return false;
    }
  }

  // Created on first use and reused after. Revalidated every call because the
  // manager may have reaped it (idle timeout) or restarted since we last looked.
  async function getSandbox(type) {
    const cached = sandboxes.get(type);
    if (cached && (await isAlive(cached))) return cached;
    sandboxes.delete(type);

    if (inFlight.has(type)) return inFlight.get(type);

    const creating = (async () => {
      const result = await managerFetch('/sandboxes', {
        method: 'POST',
        body: JSON.stringify({ type, volume }),
      });
      if (!result || result.error || !result.id) {
        throw new Error(`Could not start ${type} sandbox: ${result?.error || 'unknown error'}`);
      }
      sandboxes.set(type, result.id);
      console.error(`[agentbox] session '${sessionId}': ${type} sandbox ${result.id} on ${volume}`);
      return result.id;
    })();

    inFlight.set(type, creating);
    try {
      return await creating;
    } finally {
      inFlight.delete(type);
    }
  }

  // Explicit sandbox_id wins; otherwise fall back to this session's sandbox.
  const shellSandbox = async (explicitId) => explicitId || getSandbox('shell');
  const browserSandbox = async (explicitId) => explicitId || getSandbox('browser');

  /**
   * Tear down the session. Sandboxes always go; the volume only in
   * per-connection mode, where the workspace is scoped to the connection.
   * A fixed session's volume must survive so the agent finds its files again.
   */
  async function cleanup() {
    for (const [type, id] of [...sandboxes]) {
      try {
        await managerFetch(`/sandboxes/${id}`, { method: 'DELETE' });
      } catch (e) {
        console.error(`[agentbox] failed to destroy ${type} sandbox ${id}: ${e.message}`);
      }
      sandboxes.delete(type);
    }
    if (EPHEMERAL) {
      try {
        await managerFetch(`/volumes/${volume}`, { method: 'DELETE' });
        console.error(`[agentbox] session '${sessionId}': removed workspace ${volume}`);
      } catch (e) {
        console.error(`[agentbox] failed to remove volume ${volume}: ${e.message}`);
      }
    }
  }

  return { sessionId, volume, sandboxes, shellSandbox, browserSandbox, cleanup };
}

const SANDBOX_ID_ARG = z
  .string()
  .optional()
  .describe('Sandbox ID. Omit to use this session\'s persistent sandbox.');

async function managerFetch(path, options = {}) {
  const url = `${MANAGER_URL}${path}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(MANAGER_TOKEN ? { Authorization: `Bearer ${MANAGER_TOKEN}` } : {}),
      ...options.headers,
    },
  });
  const ct = res.headers.get('content-type') || '';
  if (ct.includes('image/')) {
    const buf = Buffer.from(await res.arrayBuffer());
    return { _image: true, base64: buf.toString('base64'), mimeType: ct };
  }
  return res.json();
}


/**
 * A server instance is built per connection. The MCP SDK binds one transport per
 * server, so sharing a single server across SSE connections would route replies
 * to whichever client connected last.
 */
function buildServer(session) {
  const server = new McpServer({ name: 'agentbox', version: '1.0.0' });
  registerTools(server, session);
  return server;
}

function registerTools(server, session) {
  const {
    shellSandbox,
    browserSandbox,
    sandboxes: sessionSandboxes,
    sessionId: SESSION_ID,
    volume: SESSION_VOLUME,
  } = session;

// --- Sandbox management tools ---

server.tool('create_sandbox',
  'Create an additional sandbox. Not required for normal use — every tool falls back to this session\'s sandbox automatically.',
  {
    type: z.enum(['browser', 'shell']).optional().describe('Sandbox type: "browser" (Chromium + VNC, default) or "shell" (lightweight, shell only)'),
    volume: z.string().optional().describe('Docker volume to mount at /workspace. Defaults to this session\'s volume, so files persist.'),
  }, async ({ type, volume }) => {
  // The manager expects `volume` (a named Docker volume). This previously sent
  // `workspace`, which the manager ignored — so sandboxes created through MCP
  // mounted nothing and lost every file when they were destroyed.
  const result = await managerFetch('/sandboxes', {
    method: 'POST',
    body: JSON.stringify({ type: type || 'browser', volume: volume || SESSION_VOLUME }),
  });
  return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
});

server.tool('session_info',
  'Show the current session id, its persistent workspace volume, and which sandboxes are live.',
  {}, async () => {
  const info = {
    session_id: SESSION_ID,
    workspace_volume: SESSION_VOLUME,
    workspace_path: '/workspace',
    session_mode: SESSION_MODE,
    active_sandboxes: Object.fromEntries(sessionSandboxes),
    note: EPHEMERAL
      ? 'Workspace is scoped to this connection and deleted when it closes.'
      : 'Files under /workspace persist across sandbox restarts and agent runs.',
  };
  return { content: [{ type: 'text', text: JSON.stringify(info, null, 2) }] };
});

server.tool('list_sandboxes', 'List all active sandboxes', {}, async () => {
  const result = await managerFetch('/sandboxes');
  return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
});

server.tool('destroy_sandbox', 'Destroy a sandbox', {
  sandbox_id: z.string().describe('Sandbox ID'),
}, async ({ sandbox_id }) => {
  const result = await managerFetch(`/sandboxes/${sandbox_id}`, { method: 'DELETE' });
  // Drop it from the session cache too, so the next tool call starts a fresh one
  // instead of reusing an id that no longer exists.
  for (const [type, id] of sessionSandboxes) {
    if (id === sandbox_id) sessionSandboxes.delete(type);
  }
  return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
});

// --- Browser tools ---

server.tool('navigate', 'Navigate browser to a URL', {
  sandbox_id: SANDBOX_ID_ARG,
  url: z.string().describe('URL to navigate to'),
}, async ({ sandbox_id, url }) => {
  const sid = await browserSandbox(sandbox_id);
  const result = await managerFetch(`/sandboxes/${sid}/browser/navigate`, {
    method: 'POST',
    body: JSON.stringify({ url }),
  });
  return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
});

server.tool('snapshot', 'Get the accessibility tree of the current page', {
  sandbox_id: SANDBOX_ID_ARG,
}, async ({ sandbox_id }) => {
  const sid = await browserSandbox(sandbox_id);
  const result = await managerFetch(`/sandboxes/${sid}/browser/snapshot`);
  return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
});

server.tool('click', 'Click an element on the page', {
  sandbox_id: SANDBOX_ID_ARG,
  ref: z.string().optional().describe('Element ref from snapshot (e.g. ref_5)'),
  text: z.string().optional().describe('Text content to click on'),
  selector: z.string().optional().describe('CSS selector'),
}, async ({ sandbox_id, ref, text, selector }) => {
  const sid = await browserSandbox(sandbox_id);
  const body = {};
  if (ref) body.ref = ref;
  if (text) body.text = text;
  if (selector) body.selector = selector;
  const result = await managerFetch(`/sandboxes/${sid}/browser/click`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
  return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
});

server.tool('type', 'Type into an input element', {
  sandbox_id: SANDBOX_ID_ARG,
  value: z.string().describe('Text to type'),
  ref: z.string().optional().describe('Element ref from snapshot'),
  selector: z.string().optional().describe('CSS selector'),
  text: z.string().optional().describe('Label text of the input'),
}, async ({ sandbox_id, value, ref, selector, text }) => {
  const sid = await browserSandbox(sandbox_id);
  const body = { value };
  if (ref) body.ref = ref;
  if (selector) body.selector = selector;
  if (text) body.text = text;
  const result = await managerFetch(`/sandboxes/${sid}/browser/type`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
  return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
});

server.tool('scroll', 'Scroll the page', {
  sandbox_id: SANDBOX_ID_ARG,
  direction: z.enum(['up', 'down', 'left', 'right']).describe('Scroll direction'),
  amount: z.number().optional().describe('Pixels to scroll (default 500)'),
}, async ({ sandbox_id, direction, amount }) => {
  const sid = await browserSandbox(sandbox_id);
  const result = await managerFetch(`/sandboxes/${sid}/browser/scroll`, {
    method: 'POST',
    body: JSON.stringify({ direction, amount }),
  });
  return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
});

server.tool('screenshot', 'Take a screenshot of the current page', {
  sandbox_id: SANDBOX_ID_ARG,
}, async ({ sandbox_id }) => {
  const sid = await browserSandbox(sandbox_id);
  const result = await managerFetch(`/sandboxes/${sid}/screenshot`);
  if (result._image) {
    return { content: [{ type: 'image', data: result.base64, mimeType: result.mimeType }] };
  }
  return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
});

server.tool('browser_back', 'Go back in browser history', {
  sandbox_id: SANDBOX_ID_ARG,
}, async ({ sandbox_id }) => {
  const sid = await browserSandbox(sandbox_id);
  const result = await managerFetch(`/sandboxes/${sid}/browser/back`, { method: 'POST' });
  return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
});

server.tool('browser_forward', 'Go forward in browser history', {
  sandbox_id: SANDBOX_ID_ARG,
}, async ({ sandbox_id }) => {
  const sid = await browserSandbox(sandbox_id);
  const result = await managerFetch(`/sandboxes/${sid}/browser/forward`, { method: 'POST' });
  return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
});

server.tool('tabs', 'List open browser tabs', {
  sandbox_id: SANDBOX_ID_ARG,
}, async ({ sandbox_id }) => {
  const sid = await browserSandbox(sandbox_id);
  const result = await managerFetch(`/sandboxes/${sid}/browser/tabs`);
  return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
});

server.tool('switch_tab', 'Switch to a browser tab', {
  sandbox_id: SANDBOX_ID_ARG,
  index: z.number().describe('Tab index'),
}, async ({ sandbox_id, index }) => {
  const sid = await browserSandbox(sandbox_id);
  const result = await managerFetch(`/sandboxes/${sid}/browser/tab`, {
    method: 'POST',
    body: JSON.stringify({ index }),
  });
  return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
});

server.tool('exec', 'Execute a shell command in the sandbox', {
  sandbox_id: SANDBOX_ID_ARG,
  command: z.string().describe('Shell command to run'),
}, async ({ sandbox_id, command }) => {
  const sid = await shellSandbox(sandbox_id);
  const result = await managerFetch(`/sandboxes/${sid}/exec`, {
    method: 'POST',
    body: JSON.stringify({ command }),
  });
  return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
});

// --- Filesystem tools (shell sandbox) ---

server.tool('read_file', 'Read a file from the sandbox', {
  sandbox_id: SANDBOX_ID_ARG,
  path: z.string().describe('File path relative to /home/sandbox'),
}, async ({ sandbox_id, path }) => {
  const sid = await shellSandbox(sandbox_id);
  const result = await managerFetch(`/sandboxes/${sid}/fs/read?path=${encodeURIComponent(path)}`);
  return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
});

server.tool('write_file', 'Write a file to the sandbox', {
  sandbox_id: SANDBOX_ID_ARG,
  path: z.string().describe('File path relative to /home/sandbox'),
  content: z.string().describe('File content'),
}, async ({ sandbox_id, path, content }) => {
  const sid = await shellSandbox(sandbox_id);
  const result = await managerFetch(`/sandboxes/${sid}/fs/write`, {
    method: 'POST',
    body: JSON.stringify({ path, content }),
  });
  return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
});

server.tool('edit_file', 'Edit a file in the sandbox using find-and-replace', {
  sandbox_id: SANDBOX_ID_ARG,
  path: z.string().describe('File path relative to /home/sandbox'),
  old_string: z.string().describe('The exact string to find in the file'),
  new_string: z.string().describe('The replacement string'),
  replace_all: z.boolean().optional().describe('Replace all occurrences (default: false, replaces first only)'),
}, async ({ sandbox_id, path, old_string, new_string, replace_all }) => {
  const sid = await shellSandbox(sandbox_id);
  const result = await managerFetch(`/sandboxes/${sid}/fs/edit`, {
    method: 'POST',
    body: JSON.stringify({ path, old_string, new_string, replace_all }),
  });
  return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
});

server.tool('list_dir', 'List directory contents in the sandbox', {
  sandbox_id: SANDBOX_ID_ARG,
  path: z.string().optional().describe('Directory path relative to /home/sandbox (default: .)'),
}, async ({ sandbox_id, path }) => {
  const sid = await shellSandbox(sandbox_id);
  const result = await managerFetch(`/sandboxes/${sid}/fs/ls?path=${encodeURIComponent(path || '.')}`);
  return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
});

server.tool('sandbox_info', 'Get system info from the sandbox', {
  sandbox_id: SANDBOX_ID_ARG,
}, async ({ sandbox_id }) => {
  const sid = await shellSandbox(sandbox_id);
  const result = await managerFetch(`/sandboxes/${sid}/info`);
  return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
});

}

// --- SSE Transport ---

const app = express();
const connections = {};

// In fixed mode every connection shares one session, so the sandboxes and the
// workspace are shared too.
const sharedSession = EPHEMERAL ? null : createSession(FIXED_SESSION_ID);

app.get('/mcp', async (req, res) => {
  const transport = new SSEServerTransport('/mcp/message', res);
  const session = EPHEMERAL
    ? createSession(`conn-${transport.sessionId}`)
    : sharedSession;

  connections[transport.sessionId] = { transport, session };
  res.on('close', async () => {
    delete connections[transport.sessionId];
    // Only ephemeral sessions are torn down here: a fixed session outlives the
    // connection so the next one reuses its sandboxes and files.
    if (EPHEMERAL) await session.cleanup();
  });

  await buildServer(session).connect(transport);
});

app.post('/mcp/message', async (req, res) => {
  const sessionId = req.query.sessionId;
  const conn = connections[sessionId];
  if (!conn) return res.status(404).json({ error: 'Session not found' });
  await conn.transport.handlePostMessage(req, res);
});

const MCP_PORT = process.env.MCP_PORT || 4001;
app.listen(MCP_PORT, '0.0.0.0', () => {
  console.log(`MCP server (SSE) listening on port ${MCP_PORT}`);
  console.log(
    EPHEMERAL
      ? '  session mode: per-connection (isolated workspace, deleted on disconnect)'
      : `  session mode: fixed — session '${FIXED_SESSION_ID}', workspace agentbox-session-${FIXED_SESSION_ID}`
  );
});
