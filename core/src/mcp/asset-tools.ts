/**
 * Asset upload over MCP (58-IMPL) — Prina hands out a one-time upload address; the file never travels
 * through MCP (tool calls carry JSON only, and base64 would bloat every image by a third).
 *
 *   asset_request_upload → { asset, upload: { url, method: PUT, headers, expiresIn } }
 *   PUT the file to upload.url with upload.headers
 *   asset_confirm_upload → the asset, ready (size, dimensions, metadata read from storage)
 *
 * The commands are the ones the admin's Media Library uses, permission checks included (the token's
 * role needs media create). A workspace can switch the pair off (`settings.mcp.agentUploads: false`):
 * behind a company network an outside agent cannot reach the storage address, and a tool that is
 * offered but always fails turns into requests to open the network. Off, the tools are not offered.
 */
import type { CommandCtx } from "../commands/context.js";
import { assetConfirmUpload, assetRequestUpload } from "../modules/asset/commands.js";
import type { McpToolDef } from "./tools.js";

type Json = Record<string, unknown>;
type Handler = (args: Json) => Promise<unknown>;

/** Whether agents may upload files over MCP in this workspace — on unless switched off */
export function agentUploadsAllowed(settings: unknown): boolean {
  const mcp = (settings as { mcp?: { agentUploads?: unknown } } | null)?.mcp;
  return mcp?.agentUploads !== false;
}

/**
 * The upload address as an agent can use it. The S3 adapter signs an absolute URL; the local adapter
 * returns a path on Prina itself, which only means something next to the address the agent called.
 */
export function absoluteUploadUrl(url: string, origin: string | undefined): string {
  if (/^https?:\/\//i.test(url) || !origin) return url;
  return `${origin.replace(/\/+$/, "")}${url.startsWith("/") ? "" : "/"}${url}`;
}

export function addAssetTools(
  add: (tool: McpToolDef, handler: Handler) => void,
  ctx: CommandCtx,
  origin: string | undefined,
): void {
  add(
    {
      name: "asset_request_upload",
      description:
        "Step 1 of 3 to add a file (an image, a PDF …) to the Media Library. Returns the new asset (status " +
        "`uploading`) and a one-time upload address valid for `upload.expiresIn` seconds. Step 2: send the file's " +
        "bytes with an HTTP PUT to `upload.url`, with every header in `upload.headers` (e.g. " +
        "`curl -X PUT -H 'content-type: image/png' --data-binary @photo.png '<url>'`). The file does not go through " +
        "this MCP connection. Step 3: call asset_confirm_upload with the asset id. `size` must be the file's exact " +
        "byte count; `mime` its real type.",
      inputSchema: {
        type: "object",
        required: ["filename", "mime", "size"],
        properties: {
          filename: { type: "string", minLength: 1, maxLength: 255, description: "File name as it should appear in the library" },
          mime: { type: "string", description: "Content type, e.g. image/png, image/jpeg, application/pdf" },
          size: { type: "integer", minimum: 1, description: "Exact size of the file in bytes" },
          folder: { type: "string", description: "Library folder path, e.g. /products/2026 (default /)" },
        },
        additionalProperties: false,
      },
    },
    async (args) => {
      const out = await assetRequestUpload.run(args, ctx);
      return { ...out, upload: { ...out.upload, url: absoluteUploadUrl(out.upload.url, origin) } };
    },
  );

  add(
    {
      name: "asset_confirm_upload",
      description:
        "Step 3 of 3: after the file was PUT to the upload address, finish the asset — Prina checks the file is in " +
        "storage and reads its size, dimensions and metadata. Returns the asset; use its `id` in an entry's media " +
        "field. Fails if the file has not been uploaded yet.",
      inputSchema: {
        type: "object",
        required: ["id"],
        properties: { id: { type: "string", format: "uuid", description: "The asset id from asset_request_upload" } },
        additionalProperties: false,
      },
    },
    (args) => assetConfirmUpload.run(args, ctx),
  );
}
