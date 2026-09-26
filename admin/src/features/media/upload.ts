/** Three-step upload flow (T4.1): request (presign) → PUT → confirm */
import { api } from "../../api/client";
import type { Asset, UploadTicket } from "../../api/types";

export async function uploadFile(file: File, folder: string): Promise<Asset> {
  const ticket = await api<UploadTicket>("/api/assets/uploads", {
    method: "POST",
    body: { filename: file.name, mime: file.type || "application/octet-stream", size: file.size, folder },
  });

  const res = await fetch(ticket.upload.url, {
    method: ticket.upload.method,
    headers: ticket.upload.headers,
    body: file,
    credentials: "same-origin",
  });
  if (!res.ok) throw new Error(`Upload failed (${res.status})`);

  return api<Asset>(`/api/assets/${ticket.asset.id}/confirm`, { method: "POST" });
}
