import { streamText, generateText, tool, stepCountIs } from "ai";
import type { UIMessageStreamWriter } from "ai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { z } from "zod";
import { getDb, appendAgentActivity, appendVncLink } from "./db";
import { nanoid } from "nanoid";

import { MANAGER_URL, managerHeaders } from "./manager";

const openrouter = createOpenAICompatible({
  name: "openrouter",
  apiKey: process.env.OPENROUTER_API_KEY!,
  baseURL: "https://openrouter.ai/api/v1",
});

// --- Manager API helpers ---

async function managerFetch(path: string, options: RequestInit = {}) {
  const res = await fetch(`${MANAGER_URL}${path}`, {
    ...options,
    headers: managerHeaders({
      "Content-Type": "application/json",
      ...(options.headers as Record<string, string> | undefined),
    }),
  });
  return res.json();
}

async function createSandbox(type: "shell" | "browser", volume: string) {
  return managerFetch("/sandboxes", {
    method: "POST",
    body: JSON.stringify({ type, volume }),
  });
}

async function destroySandbox(sandboxId: string) {
  return managerFetch(`/sandboxes/${sandboxId}`, { method: "DELETE" });
}

// --- Session volume management ---

export async function getOrCreateSessionVolume(chatId: string): Promise<string> {
  const db = getDb();
  const existing = db
    .prepare("SELECT volume_name FROM sessions WHERE chat_id = ?")
    .get(chatId) as { volume_name: string } | undefined;

  if (existing) return existing.volume_name;

  const sessionId = nanoid(12);
  const volumeName = `agentbox-session-${sessionId}`;

  db.prepare("INSERT INTO sessions (id, chat_id, volume_name) VALUES (?, ?, ?)").run(
    sessionId,
    chatId,
    volumeName
  );

  return volumeName;
}

// --- Tool factories with activity reporting ---

function createShellTools(sandboxId: string, onToolCall?: (name: string, args: any, result: any) => void) {
  const wrap = (name: string, fn: (args: any) => Promise<any>) => {
    return async (args: any) => {
      const result = await fn(args);
      onToolCall?.(name, args, result);
      return result;
    };
  };

  return {
    exec: tool({
      description: "Run a shell command in the workspace.",
      inputSchema: z.object({ command: z.string().describe("Shell command to execute") }),
      execute: wrap("exec", ({ command }) =>
        managerFetch(`/sandboxes/${sandboxId}/exec`, { method: "POST", body: JSON.stringify({ command }) })
      ),
    }),
    read_file: tool({
      description: "Read the contents of a file",
      inputSchema: z.object({ path: z.string().describe("File path") }),
      execute: wrap("read_file", ({ path }) =>
        managerFetch(`/sandboxes/${sandboxId}/fs/read?path=${encodeURIComponent(path)}`)
      ),
    }),
    write_file: tool({
      description: "Create or overwrite a file with the given content",
      inputSchema: z.object({ path: z.string().describe("File path"), content: z.string().describe("File content") }),
      execute: wrap("write_file", ({ path, content }) =>
        managerFetch(`/sandboxes/${sandboxId}/fs/write`, { method: "POST", body: JSON.stringify({ path, content }) })
      ),
    }),
    edit_file: tool({
      description: "Edit a file by replacing a specific string with another",
      inputSchema: z.object({
        path: z.string().describe("File path"),
        old_string: z.string().describe("Exact string to find"),
        new_string: z.string().describe("Replacement string"),
        replace_all: z.boolean().optional().describe("Replace all occurrences"),
      }),
      execute: wrap("edit_file", (args) =>
        managerFetch(`/sandboxes/${sandboxId}/fs/edit`, { method: "POST", body: JSON.stringify(args) })
      ),
    }),
    list_dir: tool({
      description: "List files and directories at a path",
      inputSchema: z.object({ path: z.string().optional().describe("Directory path (default: /workspace)") }),
      execute: wrap("list_dir", ({ path }) =>
        managerFetch(`/sandboxes/${sandboxId}/fs/ls?path=${encodeURIComponent(path || "/workspace")}`)
      ),
    }),
  };
}

function createBrowserTools(sandboxId: string, onToolCall?: (name: string, args: any, result: any) => void) {
  const wrap = (name: string, fn: (args: any) => Promise<any>) => {
    return async (args: any) => {
      const result = await fn(args);
      onToolCall?.(name, args, result);
      return result;
    };
  };

  return {
    ...createShellTools(sandboxId, onToolCall),
    read_page_text: tool({
      description: "Read the current page as clean plain text. Much smaller than snapshot — use this to read page content. Use snapshot only when you need to interact with elements.",
      inputSchema: z.object({}),
      execute: wrap("read_page_text", () =>
        managerFetch(`/sandboxes/${sandboxId}/browser/text`)
      ),
    }),
    navigate: tool({
      description: "Navigate the browser to a URL",
      inputSchema: z.object({ url: z.string().describe("URL to navigate to") }),
      execute: wrap("navigate", (args) =>
        managerFetch(`/sandboxes/${sandboxId}/browser/navigate`, { method: "POST", body: JSON.stringify({ url: args.url }) })
      ),
    }),
    snapshot: tool({
      description: "Get the accessibility tree of the current page.",
      inputSchema: z.object({}),
      execute: wrap("snapshot", () =>
        managerFetch(`/sandboxes/${sandboxId}/browser/snapshot`)
      ),
    }),
    screenshot: tool({
      description: "Take a screenshot of the current browser page",
      inputSchema: z.object({}),
      execute: wrap("screenshot", async () => {
        const res = await fetch(`${MANAGER_URL}/sandboxes/${sandboxId}/screenshot`, {
          headers: managerHeaders(),
        });
        const ct = res.headers.get("content-type") || "";
        if (ct.includes("image/")) {
          const buf = Buffer.from(await res.arrayBuffer());
          return { type: "image", base64: buf.toString("base64"), mimeType: ct };
        }
        return res.json();
      }),
    }),
    click: tool({
      description: "Click an element on the page by ref, text, or CSS selector",
      inputSchema: z.object({
        ref: z.string().optional().describe("Element ref from snapshot"),
        text: z.string().optional().describe("Text content to click"),
        selector: z.string().optional().describe("CSS selector"),
      }),
      execute: wrap("click", (params) =>
        managerFetch(`/sandboxes/${sandboxId}/browser/click`, { method: "POST", body: JSON.stringify(params) })
      ),
    }),
    type_text: tool({
      description: "Type text into an input element",
      inputSchema: z.object({
        value: z.string().describe("Text to type"),
        ref: z.string().optional().describe("Element ref from snapshot"),
        selector: z.string().optional().describe("CSS selector"),
        text: z.string().optional().describe("Label text of the input"),
      }),
      execute: wrap("type_text", (params) =>
        managerFetch(`/sandboxes/${sandboxId}/browser/type`, { method: "POST", body: JSON.stringify(params) })
      ),
    }),
    scroll: tool({
      description: "Scroll the page",
      inputSchema: z.object({
        direction: z.enum(["up", "down", "left", "right"]),
        amount: z.number().optional().describe("Pixels to scroll (default 500)"),
      }),
      execute: wrap("scroll", (params) =>
        managerFetch(`/sandboxes/${sandboxId}/browser/scroll`, { method: "POST", body: JSON.stringify(params) })
      ),
    }),
    browser_back: tool({
      description: "Go back in browser history",
      inputSchema: z.object({}),
      execute: wrap("browser_back", () =>
        managerFetch(`/sandboxes/${sandboxId}/browser/back`, { method: "POST" })
      ),
    }),
  };
}

// --- Agent system prompts ---

const SHELL_SYSTEM = `You are a compute agent running inside a sandboxed Linux environment with a shared workspace at /workspace.

## How to work
1. Read the task carefully
2. Use your tools to complete it step by step — write files, run commands, install packages, etc.
3. Always use /workspace as the root for all file paths
4. If a command fails, read the error and fix it before moving on
5. After ALL work is done, you MUST call submit_report

## submit_report (MANDATORY)
You MUST end every task by calling submit_report. The report goes directly to the user as the answer to their query.

Rules for the report:
- Answer the user's question directly — don't list steps you took or tools you called
- Include the actual result/output they asked for
- Keep it concise — no "I created a file", "I ran a command" narration
- If it's a coding task: mention what was created and where, plus any output
- If it's an error: explain what went wrong and what you tried

BAD: "I created hello.py using write_file, then ran it with exec. The output was Hello World."
GOOD: "Created /workspace/hello.py. Output: Hello World"

Never end without calling submit_report.`;

const BROWSER_SYSTEM = `You are a browser agent running inside a sandboxed environment with a full Chromium browser and a shared workspace at /workspace.

## How to work
1. Read the task carefully
2. Use your tools to complete it — navigate, read_page_text, click, type, screenshot, run shell commands, write files
3. To read page content: use read_page_text (clean plain text, small). Only use snapshot when you need to interact with specific elements (click, type).
4. For previewing local apps: use exec to start the dev server, then navigate to http://localhost:<port>
5. If something fails, try a different approach
6. After ALL work is done, you MUST call submit_report

## submit_report (MANDATORY)
You MUST end every task by calling submit_report. The report goes directly to the user as the answer to their query.

Rules for the report:
- Answer the user's question directly — don't narrate your browsing steps
- Include the actual information or result they asked for
- If you took a screenshot, mention it
- Keep it concise — no "I navigated to", "I clicked on" play-by-play

BAD: "I navigated to github.com/user, then I used snapshot to read the page, then I found..."
GOOD: "GitHub profile: 45 repos, 120 followers. Top projects: project-a (★230), project-b (★180). Bio: Full-stack developer."

Never end without calling submit_report.`;

// --- Agent spawning ---

export async function spawnShellAgentStreaming(
  chatId: string,
  task: string,
  writer?: UIMessageStreamWriter
): Promise<string> {
  const volume = await getOrCreateSessionVolume(chatId);
  const sandbox = await createSandbox("shell", volume);

  if (sandbox.error) {
    return `Failed to create sandbox: ${sandbox.error}`;
  }

  let report = "";
  const activities: any[] = [];

  try {
    const onToolCall = (name: string, args: any, result: any) => {
      if (name === "submit_report") return;
      const activity = {
        agentType: "shell",
        toolName: name,
        args: summarizeArgs(name, args),
        status: result?.error ? "error" : "done",
        result: summarizeResult(name, result),
      };
      activities.push(activity);
      if (writer) {
        try { writer.write({ type: "data-agent-activity" as any, data: activity } as any); } catch { }
      }
      appendAgentActivity(chatId, activity);
    };

    const tools = {
      ...createShellTools(sandbox.id, onToolCall),
      submit_report: tool({
        description: "Submit your final report. Call this ONCE when done with ALL tasks.",
        inputSchema: z.object({
          summary: z.string().describe("Concise summary answering the user's query"),
        }),
        execute: async ({ summary }) => {
          report = summary;
          return { ok: true };
        },
      }),
    };

    console.log(`[ShellAgent] Starting sandbox=${sandbox.id} task="${task.slice(0, 80)}"`);

    const result = streamText({
      model: openrouter.chatModel("minimax/minimax-m2.7"),
      maxOutputTokens: 4096,
      stopWhen: stepCountIs(20),
      system: SHELL_SYSTEM,
      prompt: task,
      tools,
    });

    const finalText = await result.text;
    const steps = await result.steps;
    console.log(`[ShellAgent] Steps: ${steps?.length}, toolCalls: ${steps?.flatMap(s => s.toolCalls?.map(tc => tc.toolName)).filter(Boolean)}, text length: ${finalText?.length}`);

    if (!report && !finalText) {
      console.log(`[ShellAgent] No report, nudging...`);
      const responseMessages = (await result.response).messages || [];
      const nudge = await generateText({
        model: openrouter.chatModel("minimax/minimax-m2.7"),
        maxOutputTokens: 4096,
        stopWhen: stepCountIs(3),
        system: SHELL_SYSTEM,
        messages: [
          ...responseMessages,
          { role: "user" as const, content: "Now call submit_report with a concise summary of what you did and the results." },
        ],
        tools: { submit_report: tools.submit_report },
      });
      // If still no report from tool, use the text
      if (!report) report = nudge.text || "";
    }

    console.log(`[ShellAgent] Completed. Report: "${(report || "").slice(0, 100)}"`);
    const resultText = report || finalText || "Task completed.";
    return JSON.stringify({ result: resultText, activities });
  } catch (e: any) {
    console.error(`[ShellAgent] Error: ${e.message}`);
    return `Agent error: ${e.message}`;
  } finally {
    await destroySandbox(sandbox.id);
  }
}

export async function spawnBrowserAgentStreaming(
  chatId: string,
  task: string,
  writer?: UIMessageStreamWriter
): Promise<string> {
  const volume = await getOrCreateSessionVolume(chatId);
  const sandbox = await createSandbox("browser", volume);

  if (sandbox.error) {
    return `Failed to create sandbox: ${sandbox.error}`;
  }

  // Emit VNC link so the user can watch live
  if (sandbox.ports?.novnc) {
    const vncData = {
      sandboxId: sandbox.id,
      url: `http://localhost:${sandbox.ports.novnc}/vnc.html?autoconnect=true&resize=scale`,
      port: sandbox.ports.novnc,
    };
    // Persist to DB so it survives reload
    appendVncLink(chatId, vncData);
  }
  if (writer && sandbox.ports?.novnc) {
    try {
      writer.write({
        type: "data-vnc-link" as any,
        data: {
          sandboxId: sandbox.id,
          url: `http://localhost:${sandbox.ports.novnc}/vnc.html?autoconnect=true&resize=scale`,
          port: sandbox.ports.novnc,
        },
      } as any);
    } catch { }
  }

  let report = "";
  const activities: any[] = [];

  try {
    const onToolCall = (name: string, args: any, result: any) => {
      if (name === "submit_report") return;
      const activity = {
        agentType: "browser",
        toolName: name,
        args: summarizeArgs(name, args),
        status: result?.error ? "error" : "done",
        result: summarizeResult(name, result),
      };
      activities.push(activity);
      if (writer) {
        try { writer.write({ type: "data-agent-activity" as any, data: activity } as any); } catch { }
      }
      appendAgentActivity(chatId, activity);
    };

    const tools = {
      ...createBrowserTools(sandbox.id, onToolCall),
      submit_report: tool({
        description: "Submit your final report. Call this ONCE when done with ALL tasks.",
        inputSchema: z.object({
          summary: z.string().describe("Concise summary answering the user's query"),
        }),
        execute: async ({ summary }) => {
          report = summary;
          return { ok: true };
        },
      }),
    };

    console.log(`[BrowserAgent] Starting sandbox=${sandbox.id} task="${task.slice(0, 80)}"`);

    const result = streamText({
      model: openrouter.chatModel("minimax/minimax-m2.7"),
      maxOutputTokens: 4096,
      stopWhen: stepCountIs(20),
      system: BROWSER_SYSTEM,
      prompt: task,
      tools,
    });

    const finalText = await result.text;
    const steps = await result.steps;
    console.log(`[BrowserAgent] Steps: ${steps?.length}, toolCalls: ${steps?.flatMap(s => s.toolCalls?.map(tc => tc.toolName)).filter(Boolean)}, text length: ${finalText?.length}`);

    if (!report && !finalText) {
      console.log(`[BrowserAgent] No report, nudging...`);
      const responseMessages = (await result.response).messages || [];
      const nudge = await generateText({
        model: openrouter.chatModel("minimax/minimax-m2.7"),
        maxOutputTokens: 4096,
        stopWhen: stepCountIs(3),
        system: BROWSER_SYSTEM,
        messages: [
          ...responseMessages,
          { role: "user" as const, content: "Now call submit_report with a concise summary of what you found and the results." },
        ],
        tools: { submit_report: tools.submit_report },
      });
      if (!report) report = nudge.text || "";
    }

    console.log(`[BrowserAgent] Completed. Report: "${(report || "").slice(0, 100)}"`);
    const resultText = report || finalText || "Task completed.";
    return JSON.stringify({ result: resultText, activities, vncPort: sandbox.ports?.novnc });
  } catch (e: any) {
    console.error(`[BrowserAgent] Error: ${e.message}`);
    return `Agent error: ${e.message}`;
  } finally {
    await destroySandbox(sandbox.id);
  }
}

// --- Helpers to keep data parts concise ---

function summarizeArgs(toolName: string, args: any): string {
  switch (toolName) {
    case "exec": return args.command || "";
    case "write_file": return args.path || "";
    case "read_file": return args.path || "";
    case "edit_file": return args.path || "";
    case "list_dir": return args.path || "/workspace";
    case "navigate": return args.url || "";
    case "click": return args.text || args.selector || args.ref || "";
    case "type_text": return args.value?.slice(0, 50) || "";
    case "scroll": return args.direction || "";
    case "screenshot": return "";
    case "snapshot": return "";
    default: return JSON.stringify(args).slice(0, 80);
  }
}

function summarizeResult(toolName: string, result: any): string {
  if (!result) return "";
  if (result.error) return `Error: ${result.error}`;
  switch (toolName) {
    case "exec": return result.stdout?.trim().slice(0, 200) || (result.exitCode === 0 ? "OK" : `Exit ${result.exitCode}`);
    case "write_file": return result.ok ? "Written" : "";
    case "read_file": return result.content ? `${result.content.length} chars` : "";
    case "edit_file": return result.ok ? "Edited" : "";
    case "list_dir": return `${result.entries?.length || 0} items`;
    case "navigate": return result.title || result.url || "";
    case "screenshot": return "Captured";
    case "snapshot": return `${JSON.stringify(result).length} bytes`;
    default: return JSON.stringify(result).slice(0, 100);
  }
}
