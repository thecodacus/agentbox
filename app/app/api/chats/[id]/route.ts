import { getDb, listDeploymentsForChat, deleteDeployment } from "@/lib/db";

import { MANAGER_URL, managerHeaders } from "@/lib/manager";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const db = getDb();
  const chat = db.prepare("SELECT * FROM chats WHERE id = ?").get(id);
  if (!chat) return Response.json({ error: "Not found" }, { status: 404 });
  return Response.json(chat);
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await req.json();
  const db = getDb();

  const fields: string[] = [];
  const values: unknown[] = [];

  if (body.title !== undefined) { fields.push("title = ?"); values.push(body.title); }
  if (body.messages !== undefined) { fields.push("messages = ?"); values.push(JSON.stringify(body.messages)); }
  fields.push("updated_at = datetime('now')");
  values.push(id);

  db.prepare(`UPDATE chats SET ${fields.join(", ")} WHERE id = ?`).run(...values);
  return Response.json({ ok: true });
}

export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const db = getDb();

  // Stop and remove all deployments for this chat
  const deployments = listDeploymentsForChat(id) as Array<{ id: string; container_id: string }>;
  for (const dep of deployments) {
    try {
      await fetch(`${MANAGER_URL}/deployments/${dep.container_id}`, {
        method: "DELETE",
        headers: managerHeaders(),
      });
    } catch (e) {
      console.error("Failed to stop deployment:", e);
    }
    deleteDeployment(dep.id);
  }

  // Find the volume for this chat
  const session = db
    .prepare("SELECT volume_name FROM sessions WHERE chat_id = ?")
    .get(id) as { volume_name: string } | undefined;

  // Delete the volume via manager API
  if (session?.volume_name) {
    try {
      await fetch(`${MANAGER_URL}/volumes/${session.volume_name}`, {
        method: "DELETE",
        headers: managerHeaders(),
      });
    } catch (e) {
      console.error("Failed to delete volume:", e);
    }
  }

  // Delete chat and session rows
  db.prepare("DELETE FROM sessions WHERE chat_id = ?").run(id);
  db.prepare("DELETE FROM chats WHERE id = ?").run(id);

  return Response.json({ ok: true });
}
