import { getDeployment, deleteDeployment, updateDeploymentStatus } from "@/lib/db";

import { MANAGER_URL, managerHeaders } from "@/lib/manager";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const deployment = getDeployment(id);
  if (!deployment) return Response.json({ error: "Not found" }, { status: 404 });

  // Fetch live status from manager
  try {
    const res = await fetch(`${MANAGER_URL}/deployments/${deployment.container_id}/status`, {
      headers: managerHeaders(),
    });
    if (res.ok) {
      const { running, status } = await res.json();
      const newStatus = running ? "running" : status || "stopped";
      if (newStatus !== deployment.status) {
        updateDeploymentStatus(id, newStatus);
        deployment.status = newStatus;
      }
    } else {
      updateDeploymentStatus(id, "stopped");
      deployment.status = "stopped";
    }
  } catch {}

  return Response.json(deployment);
}

export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const deployment = getDeployment(id);
  if (!deployment) return Response.json({ error: "Not found" }, { status: 404 });

  // Stop container via manager
  try {
    await fetch(`${MANAGER_URL}/deployments/${deployment.container_id}`, {
      method: "DELETE",
      headers: managerHeaders(),
    });
  } catch (e) {
    console.error("Failed to stop deployment container:", e);
  }

  deleteDeployment(id);
  return Response.json({ ok: true });
}
