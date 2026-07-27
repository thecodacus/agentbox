const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { SSEServerTransport } = require('@modelcontextprotocol/sdk/server/sse.js');
const express = require('express');
const { z } = require('zod');

const MANAGER_URL = process.env.MANAGER_URL || 'http://localhost:4000';
const MANAGER_TOKEN = process.env.MANAGER_TOKEN || '';

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

const server = new McpServer({
  name: 'agentbox',
  version: '1.0.0',
});

// --- Sandbox management tools ---

server.tool('create_sandbox', 'Create a new AgentBox sandbox', {
  type: z.enum(['browser', 'shell']).optional().describe('Sandbox type: "browser" (Chromium + VNC, default) or "shell" (lightweight, shell only)'),
  workspace: z.string().optional().describe('Absolute host path to mount at /workspace in the sandbox'),
}, async ({ type, workspace }) => {
  const body = { type: type || 'browser' };
  if (workspace) body.workspace = workspace;
  const result = await managerFetch('/sandboxes', {
    method: 'POST',
    body: JSON.stringify(body),
  });
  return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
});

server.tool('list_sandboxes', 'List all active sandboxes', {}, async () => {
  const result = await managerFetch('/sandboxes');
  return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
});

server.tool('destroy_sandbox', 'Destroy a sandbox', {
  sandbox_id: z.string().describe('Sandbox ID'),
}, async ({ sandbox_id }) => {
  const result = await managerFetch(`/sandboxes/${sandbox_id}`, { method: 'DELETE' });
  return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
});

// --- Browser tools ---

server.tool('navigate', 'Navigate browser to a URL', {
  sandbox_id: z.string().describe('Sandbox ID'),
  url: z.string().describe('URL to navigate to'),
}, async ({ sandbox_id, url }) => {
  const result = await managerFetch(`/sandboxes/${sandbox_id}/browser/navigate`, {
    method: 'POST',
    body: JSON.stringify({ url }),
  });
  return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
});

server.tool('snapshot', 'Get the accessibility tree of the current page', {
  sandbox_id: z.string().describe('Sandbox ID'),
}, async ({ sandbox_id }) => {
  const result = await managerFetch(`/sandboxes/${sandbox_id}/browser/snapshot`);
  return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
});

server.tool('click', 'Click an element on the page', {
  sandbox_id: z.string().describe('Sandbox ID'),
  ref: z.string().optional().describe('Element ref from snapshot (e.g. ref_5)'),
  text: z.string().optional().describe('Text content to click on'),
  selector: z.string().optional().describe('CSS selector'),
}, async ({ sandbox_id, ref, text, selector }) => {
  const body = {};
  if (ref) body.ref = ref;
  if (text) body.text = text;
  if (selector) body.selector = selector;
  const result = await managerFetch(`/sandboxes/${sandbox_id}/browser/click`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
  return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
});

server.tool('type', 'Type into an input element', {
  sandbox_id: z.string().describe('Sandbox ID'),
  value: z.string().describe('Text to type'),
  ref: z.string().optional().describe('Element ref from snapshot'),
  selector: z.string().optional().describe('CSS selector'),
  text: z.string().optional().describe('Label text of the input'),
}, async ({ sandbox_id, value, ref, selector, text }) => {
  const body = { value };
  if (ref) body.ref = ref;
  if (selector) body.selector = selector;
  if (text) body.text = text;
  const result = await managerFetch(`/sandboxes/${sandbox_id}/browser/type`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
  return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
});

server.tool('scroll', 'Scroll the page', {
  sandbox_id: z.string().describe('Sandbox ID'),
  direction: z.enum(['up', 'down', 'left', 'right']).describe('Scroll direction'),
  amount: z.number().optional().describe('Pixels to scroll (default 500)'),
}, async ({ sandbox_id, direction, amount }) => {
  const result = await managerFetch(`/sandboxes/${sandbox_id}/browser/scroll`, {
    method: 'POST',
    body: JSON.stringify({ direction, amount }),
  });
  return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
});

server.tool('screenshot', 'Take a screenshot of the current page', {
  sandbox_id: z.string().describe('Sandbox ID'),
}, async ({ sandbox_id }) => {
  const result = await managerFetch(`/sandboxes/${sandbox_id}/screenshot`);
  if (result._image) {
    return { content: [{ type: 'image', data: result.base64, mimeType: result.mimeType }] };
  }
  return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
});

server.tool('browser_back', 'Go back in browser history', {
  sandbox_id: z.string().describe('Sandbox ID'),
}, async ({ sandbox_id }) => {
  const result = await managerFetch(`/sandboxes/${sandbox_id}/browser/back`, { method: 'POST' });
  return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
});

server.tool('browser_forward', 'Go forward in browser history', {
  sandbox_id: z.string().describe('Sandbox ID'),
}, async ({ sandbox_id }) => {
  const result = await managerFetch(`/sandboxes/${sandbox_id}/browser/forward`, { method: 'POST' });
  return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
});

server.tool('tabs', 'List open browser tabs', {
  sandbox_id: z.string().describe('Sandbox ID'),
}, async ({ sandbox_id }) => {
  const result = await managerFetch(`/sandboxes/${sandbox_id}/browser/tabs`);
  return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
});

server.tool('switch_tab', 'Switch to a browser tab', {
  sandbox_id: z.string().describe('Sandbox ID'),
  index: z.number().describe('Tab index'),
}, async ({ sandbox_id, index }) => {
  const result = await managerFetch(`/sandboxes/${sandbox_id}/browser/tab`, {
    method: 'POST',
    body: JSON.stringify({ index }),
  });
  return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
});

server.tool('exec', 'Execute a shell command in the sandbox', {
  sandbox_id: z.string().describe('Sandbox ID'),
  command: z.string().describe('Shell command to run'),
}, async ({ sandbox_id, command }) => {
  const result = await managerFetch(`/sandboxes/${sandbox_id}/exec`, {
    method: 'POST',
    body: JSON.stringify({ command }),
  });
  return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
});

// --- Filesystem tools (shell sandbox) ---

server.tool('read_file', 'Read a file from the sandbox', {
  sandbox_id: z.string().describe('Sandbox ID'),
  path: z.string().describe('File path relative to /home/sandbox'),
}, async ({ sandbox_id, path }) => {
  const result = await managerFetch(`/sandboxes/${sandbox_id}/fs/read?path=${encodeURIComponent(path)}`);
  return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
});

server.tool('write_file', 'Write a file to the sandbox', {
  sandbox_id: z.string().describe('Sandbox ID'),
  path: z.string().describe('File path relative to /home/sandbox'),
  content: z.string().describe('File content'),
}, async ({ sandbox_id, path, content }) => {
  const result = await managerFetch(`/sandboxes/${sandbox_id}/fs/write`, {
    method: 'POST',
    body: JSON.stringify({ path, content }),
  });
  return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
});

server.tool('edit_file', 'Edit a file in the sandbox using find-and-replace', {
  sandbox_id: z.string().describe('Sandbox ID'),
  path: z.string().describe('File path relative to /home/sandbox'),
  old_string: z.string().describe('The exact string to find in the file'),
  new_string: z.string().describe('The replacement string'),
  replace_all: z.boolean().optional().describe('Replace all occurrences (default: false, replaces first only)'),
}, async ({ sandbox_id, path, old_string, new_string, replace_all }) => {
  const result = await managerFetch(`/sandboxes/${sandbox_id}/fs/edit`, {
    method: 'POST',
    body: JSON.stringify({ path, old_string, new_string, replace_all }),
  });
  return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
});

server.tool('list_dir', 'List directory contents in the sandbox', {
  sandbox_id: z.string().describe('Sandbox ID'),
  path: z.string().optional().describe('Directory path relative to /home/sandbox (default: .)'),
}, async ({ sandbox_id, path }) => {
  const result = await managerFetch(`/sandboxes/${sandbox_id}/fs/ls?path=${encodeURIComponent(path || '.')}`);
  return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
});

server.tool('sandbox_info', 'Get system info from the sandbox', {
  sandbox_id: z.string().describe('Sandbox ID'),
}, async ({ sandbox_id }) => {
  const result = await managerFetch(`/sandboxes/${sandbox_id}/info`);
  return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
});

// --- SSE Transport ---

const app = express();
const transports = {};

app.get('/mcp', async (req, res) => {
  const transport = new SSEServerTransport('/mcp/message', res);
  transports[transport.sessionId] = transport;
  res.on('close', () => delete transports[transport.sessionId]);
  await server.connect(transport);
});

app.post('/mcp/message', async (req, res) => {
  const sessionId = req.query.sessionId;
  const transport = transports[sessionId];
  if (!transport) return res.status(404).json({ error: 'Session not found' });
  await transport.handlePostMessage(req, res);
});

const MCP_PORT = process.env.MCP_PORT || 4001;
app.listen(MCP_PORT, '0.0.0.0', () => {
  console.log(`MCP server (SSE) listening on port ${MCP_PORT}`);
});
