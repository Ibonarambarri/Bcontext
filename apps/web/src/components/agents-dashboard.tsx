"use client";

import { AgentConnectionsTab } from "./agent-connections-tab";
import { ToolProvidersView } from "./tools/tool-providers-view";
import { type WorkspaceAddress } from "@/web/workspace-url";

/**
 * The two admin surfaces that render under `v/<slug>` as system views:
 * `agents` (connected agents, with Add agent and each agent's tool grants)
 * and `tools` (the MCP servers and API/workflow providers agents reach
 * through Bcontext's MCP, plus the outbound signed webhooks). The `webhooks`
 * slug, which stood in for `tools` while the gateway was gone, redirects to
 * `tools` in `v/[view]/page.tsx`.
 */
export type WorkspaceAdminSurface = "agents" | "tools";

/** Mounted by `v/[view]/page.tsx` for the admin slugs; the shell's header owns the title. */
export function WorkspaceAdminPage({ workspace, surface }: { workspace: WorkspaceAddress; surface: WorkspaceAdminSurface }) {
  return (
    <div className="scroll h-full overflow-y-auto bg-[var(--paper)]">
      <div className="mx-auto max-w-[1080px] px-5 pb-20 pt-9 sm:px-8 xl:px-12">
        {/* Title lives in the shell's content header. Endpoint setup, client
            config snippets and token creation live inside the Add agent
            modal (add-agent-modal.tsx), not on the agents page. */}
        {surface === "agents" && <AgentConnectionsTab workspace={workspace} />}
        {surface === "tools" && <ToolProvidersView workspace={workspace} />}
      </div>
    </div>
  );
}
