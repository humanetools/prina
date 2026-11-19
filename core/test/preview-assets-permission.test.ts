/** Preview assets are template tooling: developer/editor roles may set them; other settings stay admin-only (2026-11-05) */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { workspaceGetSettings, workspaceUpdateSettings } from "../src/modules/workspace/commands.js";
import { setupTestContext, type TestContext } from "./helpers.js";

let t: TestContext;
beforeAll(async () => { t = await setupTestContext(); });
afterAll(async () => { await t.cleanup(); });

describe("workspace.update_settings permission", () => {
  const assets = [{ type: "site_assets", field: "site_css", as: "css" }];

  it("a developer + editor + publisher user (hikrobot FE account) can save previewAssets", async () => {
    const { ctx } = await t.createUserCtx(["developer", "editor", "publisher"]);
    const out = await workspaceUpdateSettings.run({ settings: { previewAssets: assets } }, ctx);
    expect((out.settings as { previewAssets: unknown }).previewAssets).toEqual(assets);
  });

  it("an editor alone can too (templates:update)", async () => {
    const { ctx } = await t.createUserCtx(["editor"]);
    await expect(workspaceUpdateSettings.run({ settings: { previewAssets: [] } }, ctx)).resolves.toBeTruthy();
  });

  it("other keys — or previewAssets mixed with them — still need settings:update", async () => {
    const { ctx } = await t.createUserCtx(["developer", "editor", "publisher"]);
    await expect(workspaceUpdateSettings.run({ settings: { currency: "USD" } }, ctx)).rejects.toMatchObject({ statusCode: 403 });
    await expect(workspaceUpdateSettings.run({ settings: { previewAssets: assets, currency: "USD" } }, ctx)).rejects.toMatchObject({ statusCode: 403 });
    await expect(workspaceUpdateSettings.run({ settings: {} }, ctx)).rejects.toMatchObject({ statusCode: 403 });
  });

  it("a publisher alone cannot (no templates:update)", async () => {
    const { ctx } = await t.createUserCtx(["publisher"]);
    await expect(workspaceUpdateSettings.run({ settings: { previewAssets: assets } }, ctx)).rejects.toMatchObject({ statusCode: 403 });
  });

  it("admin keeps full access", async () => {
    await workspaceUpdateSettings.run({ settings: { currency: "KRW", previewAssets: assets } }, t.ctx);
    const s = await workspaceGetSettings.run({}, t.ctx);
    expect((s.settings as { currency?: string }).currency).toBe("KRW");
  });
});
