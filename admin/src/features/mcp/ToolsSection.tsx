/** Tool list (P10) — auto-generation info banner + table, schema viewer toggle */
import { Fragment, useState } from "react";
import { useMcpTools } from "../../hooks/queries";

export function ToolsSection() {
  const [plane, setPlane] = useState("management");
  const { data: tools, isLoading } = useMcpTools(plane);
  const [open, setOpen] = useState<string | null>(null);

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Tools</h1>
          <span className="muted">
            Generated from content type definitions — changing a type refreshes tools and schemas immediately.
          </span>
        </div>
        <div className="seg">
          <button className={plane === "management" ? "active" : ""} onClick={() => setPlane("management")}>
            Management
          </button>
          <button className={plane === "delivery" ? "active" : ""} onClick={() => setPlane("delivery")}>
            Delivery
          </button>
        </div>
      </div>

      <div className="panel-card">
        <div className="section-banner accent">
          <span className="dot-accent" />
          Tools are generated from content types — a schema change notifies connected clients via tools/list_changed
        </div>
        <table className="data-table">
          <thead>
            <tr>
              <th style={{ width: "24rem" }}>Tool</th>
              <th>Description</th>
              <th style={{ width: "10rem" }} />
            </tr>
          </thead>
          <tbody>
            {isLoading && <tr><td colSpan={3} className="muted">Loading…</td></tr>}
            {(tools ?? []).map((tool) => (
              <Fragment key={tool.name}>
                <tr>
                  <td className="mono">{tool.name}</td>
                  <td className="col-meta">{tool.description}</td>
                  <td style={{ textAlign: "right" }}>
                    <button
                      className="btn btn-sm"
                      onClick={() => setOpen(open === tool.name ? null : tool.name)}
                    >
                      Schema
                    </button>
                  </td>
                </tr>
                {open === tool.name && (
                  <tr>
                    <td colSpan={3} style={{ height: "auto", padding: "0" }}>
                      <pre className="code-area readonly" style={{ minHeight: "auto", margin: "1.4rem" }}>
                        {JSON.stringify(tool.inputSchema, null, 2)}
                      </pre>
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
