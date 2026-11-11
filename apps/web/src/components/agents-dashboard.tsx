"use client";

import { AgentConnectionsTab } from "./agent-connections-tab";
import { WebhooksView } from "./webhooks/webhooks-view";
import { type WorkspaceAddress } from "@/web/workspace-url";

/**
 * The two admin surfaces that render under `v/<slug>` as system views:
 * `agents` (connected agents, with Add agent) and `webhooks` (outbound
 * signed webhook endpoints). The retired `tools` slug redirects to
 * `webhooks` in `v/[view]/page.tsx`.
 */
export type WorkspaceAdminSurface = "agents" | "webhooks";

/** Mounted by `v/[view]/page.tsx` for the admin slugs; the shell's header owns the title. */
export function WorkspaceAdminPage({ workspace, surface }: { workspace: WorkspaceAddress; surface: WorkspaceAdminSurface }) {
  return (
    <div className="scroll h-full overflow-y-auto bg-[var(--paper)]">
      <div className="mx-auto max-w-[1080px] px-5 pb-20 pt-9 sm:px-8 xl:px-12">
        {/* Title lives in the shell's content header. Endpoint setup, client
            config snippets and token creation live inside the Add agent
            modal (add-agent-modal.tsx), not on the agents page. */}
        {surface === "agents" && <AgentConnectionsTab workspace={workspace} />}
        {surface === "webhooks" && <WebhooksView workspace={workspace} />}
      </div>
    </div>
  );
}
