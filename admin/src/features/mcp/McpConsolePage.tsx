/** MCP console (P10, T6.4) — control tower for AI operations: tokens, tools, AI activity log */
import { useState } from "react";
import { SectionLayout } from "../../layout/SectionLayout";
import { ConnectSection } from "./ConnectSection";
import { TokensSection } from "./TokensSection";
import { ToolsSection } from "./ToolsSection";
import { adminEe } from "../../ee-loader";

type Section = "connect" | "tokens" | "tools" | "activity";

const ITEMS: Array<{ key: Section; label: string }> = [
  // First: onboarding shows the MCP URL once, and this is where it lives afterwards
  { key: "connect", label: "Connect" },
  { key: "tokens", label: "Agents · tokens" },
  { key: "tools", label: "Tools" },
  // AI activity log is EE (depends on the audit query API — label strings are EE-owned too)
  ...(adminEe ? [adminEe.mcpActivityItem] : []),
];

export function McpConsolePage() {
  const [section, setSection] = useState<Section>("connect");

  const panel = (
    <div className="nav-group">
      {ITEMS.map((i) => (
        <button key={i.key}
          className={section === i.key ? "nav-item active" : "nav-item"}
          onClick={() => setSection(i.key)}>
          {i.label}
        </button>
      ))}
    </div>
  );

  return (
    <SectionLayout panelTitle="MCP console" panel={panel}>
      {section === "connect" && <ConnectSection />}
      {section === "tokens" && <TokensSection />}
      {section === "tools" && <ToolsSection />}
      {section === "activity" && adminEe && <adminEe.McpActivitySection />}
    </SectionLayout>
  );
}
