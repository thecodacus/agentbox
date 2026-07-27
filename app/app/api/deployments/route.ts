import { getDb, listDeployments, saveDeployment } from "@/lib/db";
import { nanoid } from "nanoid";

import { MANAGER_URL, managerHeaders } from "@/lib/manager";

export async function GET() {
  const deployments = listDeployments();
  return Response.json({ deployments });
}

export async function POST(req: Request) {
  const { chatId, name, type, workdir, command, ports } = await req.json();

  if (!chatId || !name || !type) {
    return Response.json({ error: "chatId, name, and type are required" }, { status: 400 });
  }

  // Get volume for this chat
  const db = getDb();
  const session = db
    .prepare("SELECT volume_name FROM sessions WHERE chat_id = ?")
    .get(chatId) as { volume_name: string } | undefined;

  if (!session?.volume_name) {
    return Response.json({ error: "No workspace volume found for this chat" }, { status: 400 });
  }

  // Call manager to create the deployment container
  const managerRes = await fetch(`${MANAGER_URL}/deployments`, {
    method: "POST",
    headers: managerHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({
      type,
      volume: session.volume_name,
      workdir: workdir || "",
      command: command || "",
      ports: ports || [8080],
    }),
  });

  const managerResult = await managerRes.json();
  if (managerResult.error) {
    return Response.json({ error: managerResult.error }, { status: 500 });
  }

  // Save to DB
  const id = nanoid(12);
  const row = {
    id,
    chat_id: chatId,
    name,
    type,
    workdir: workdir || "",
    command: command || "",
    ports: JSON.stringify(ports || [8080]),
    published_ports: JSON.stringify(managerResult.publishedPorts || {}),
    container_id: managerResult.containerId,
    volume_name: session.volume_name,
    status: "running",
  };
  saveDeployment(row);

  return Response.json({
    id,
    name,
    type,
    publishedPorts: managerResult.publishedPorts,
    containerId: managerResult.containerId,
    status: "running",
  });
}
