// @vitest-environment jsdom
/**
 * Settings › AI › Glossary (37-IMPL) — columns follow the locale order the server sends, a
 * typed row is saved whole through PUT, and an uploaded file lands in the grid unsaved.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { GlossaryTab } from "./GlossaryTab";

const VIEW = {
  locales: [{ code: "ko", name: "Korean" }, { code: "en", name: "English" }, { code: "ja", name: "Japanese" }],
  rows: [{ id: "11111111-1111-4111-8111-111111111111", terms: { ko: "프리나", en: "Prina" } }],
};

function stubFetch() {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    if (url === "/api/ai/glossary" && (!init?.method || init.method === "GET")) return json(VIEW);
    if (url === "/api/ai/glossary" && init?.method === "PUT") {
      const body = JSON.parse(String(init.body)) as { rows: Array<{ id?: string; terms: Record<string, string> }> };
      return json({ rows: body.rows.map((r, i) => ({ id: r.id ?? `new-${i}`, terms: r.terms })) });
    }
    if (url === "/api/ai/glossary/parse") {
      return json({ rows: [{ terms: { ko: "허브", en: "Hub" } }, { terms: { ko: "번역", ja: "翻訳" } }], columns: ["ko", "en", "ja"], ignoredColumns: ["Memo"] });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  }));
  return calls;
}

const mount = () =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <GlossaryTab />
    </QueryClientProvider>,
  );

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("GlossaryTab", () => {
  it("draws one column per locale in server order and the saved rows", async () => {
    stubFetch();
    mount();
    expect(await screen.findByDisplayValue("프리나")).toBeTruthy();
    const heads = screen.getAllByRole("columnheader").map((h) => h.textContent);
    expect(heads.slice(1, 4)).toEqual(["Korean · defaultko", "Englishen", "Japaneseja"]);
    expect(screen.getByDisplayValue("Prina")).toBeTruthy();
    expect(screen.getByText("1 term saved")).toBeTruthy();
  });

  it("adds a row, takes typed terms and saves the whole grid", async () => {
    const calls = stubFetch();
    mount();
    await screen.findByDisplayValue("프리나");
    fireEvent.click(screen.getByRole("button", { name: "Add row" }));
    fireEvent.change(screen.getByLabelText("Korean term, row 2"), { target: { value: "허브" } });
    fireEvent.change(screen.getByLabelText("English term, row 2"), { target: { value: "Hub" } });
    expect(screen.getByText("Unsaved changes")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.getByText("Saved — 2 terms")).toBeTruthy());
    const put = calls.find((c) => c.init?.method === "PUT");
    expect(JSON.parse(String(put!.init!.body))).toEqual({
      rows: [
        { id: VIEW.rows[0]!.id, terms: { ko: "프리나", en: "Prina" } },
        { terms: { ko: "허브", en: "Hub" } },
      ],
    });
  });

  it("loads an uploaded file into the grid as unsaved rows", async () => {
    stubFetch();
    mount();
    await screen.findByDisplayValue("프리나");
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File(["x"], "terms.xlsx", { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
    fireEvent.change(input, { target: { files: [file] } });
    expect(await screen.findByDisplayValue("翻訳")).toBeTruthy();
    expect(screen.queryByDisplayValue("프리나")).toBeNull();
    expect(screen.getByText(/2 rows loaded from terms\.xlsx/)).toBeTruthy();
    expect(screen.getByText(/ignored columns: Memo/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    expect(screen.getByDisplayValue("프리나")).toBeTruthy();
  });
});
