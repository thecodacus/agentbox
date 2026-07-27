import { getDb } from "@/lib/db";

import { MANAGER_URL, managerHeaders } from "@/lib/manager";

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

async function createTempSandbox(volumeName: string) {
  return managerFetch("/sandboxes", {
    method: "POST",
    body: JSON.stringify({ type: "shell", volume: volumeName }),
  });
}

async function destroySandbox(sandboxId: string) {
  return managerFetch(`/sandboxes/${sandboxId}`, { method: "DELETE" });
}

function getVolumeForChat(chatId: string): string | null {
  const db = getDb();
  const row = db
    .prepare("SELECT volume_name FROM sessions WHERE chat_id = ?")
    .get(chatId) as { volume_name: string } | undefined;
  return row?.volume_name || null;
}

// GET /api/volumes/[chatId]?path=/workspace — list or read
export async function GET(
  req: Request,
  { params }: { params: Promise<{ chatId: string }> }
) {
  const { chatId } = await params;
  const url = new URL(req.url);
  const path = url.searchParams.get("path") || "/workspace";
  const action = url.searchParams.get("action") || "ls";

  const volume = getVolumeForChat(chatId);
  if (!volume) return Response.json({ error: "No volume for this chat" }, { status: 404 });

  const sandbox = await createTempSandbox(volume);
  if (sandbox.error) return Response.json({ error: sandbox.error }, { status: 500 });

  try {
    if (action === "read") {
      const result = await managerFetch(
        `/sandboxes/${sandbox.id}/fs/read?path=${encodeURIComponent(path)}`
      );
      return Response.json(result);
    }
    const result = await managerFetch(
      `/sandboxes/${sandbox.id}/fs/ls?path=${encodeURIComponent(path)}`
    );
    return Response.json(result);
  } finally {
    await destroySandbox(sandbox.id);
  }
}
