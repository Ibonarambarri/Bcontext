"use client";

/**
 * Empty workspace — shown by the workspace home (`/w/<ws>/page.tsx`) when
 * the workspace has no nodes.
 *
 * It points at the agent, not at a form: in Bcontext the agents write (over
 * the MCP) and the web reads and reviews, so the first node should come from
 * an agent. Two steps — connect one (the Agents view, where "Add agent"
 * hands out the MCP config) and paste a first prompt (`FIRST_WRITE_PROMPT`,
 * the same one the getting-started guide offers). Creating a node by hand
 * stays one quiet link away (the create dialog's `bcontext:new-node` event),
 * so nobody is stuck without an agent.
 */
import { useCallback } from "react";
import Link from "next/link";
import { Bot, Copy, MessageSquareText, Plug } from "lucide-react";
import { EmptyState } from "@/components/ui/empty-state";
import { Button } from "@heroui/react";
import { systemViewPath } from "@/lib/view-shell";
import { FIRST_WRITE_PROMPT } from "./onboarding/steps";
import { useWorkspace } from "./workspace-context";

export function WorkspaceEmptyState() {
  const { address, toast } = useWorkspace();

  const copyPrompt = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(FIRST_WRITE_PROMPT);
      toast.info("Prompt copied — paste it into your agent.");
    } catch {
      toast.error("Could not copy. Select the text and copy it by hand.");
    }
  }, [toast]);

  return (
    <EmptyState className="mt-4 min-h-[420px] rounded-2xl border border-dashed border-[var(--line)] bg-[var(--paper-2)] px-6 py-12">
      <EmptyState.Header>
        <EmptyState.Media variant="icon">
          <Bot size={18} />
        </EmptyState.Media>
        <EmptyState.Title className="serif-able text-[20px] text-[var(--ink)]">
          Your agents write here
        </EmptyState.Title>
        <EmptyState.Description className="max-w-[460px]">
          Connect Claude Code, Codex or Cursor and ask it to record what you decide and plan. You read and review it here.
        </EmptyState.Description>
      </EmptyState.Header>
      <EmptyState.Content className="w-full max-w-[560px] flex-col items-stretch gap-3 text-left">
        <div className="flex items-start gap-3 rounded-lg border border-[var(--line)] bg-[var(--paper)] px-4 py-3">
          <Plug size={15} className="mt-0.5 shrink-0 text-[var(--ink-3)]" />
          <div className="min-w-0 flex-1">
            <p className="text-[13px] text-[var(--ink)]">1. Connect an agent</p>
            <p className="mt-0.5 text-[12px] text-muted">Add agent gives you the MCP config to paste into your agent.</p>
          </div>
          <Link
            href={systemViewPath(address, "agents")}
            className="shrink-0 self-center rounded-md border border-[var(--line)] px-2.5 py-1 text-[12px] text-[var(--ink)] hover:bg-[var(--paper-2)]"
          >
            Open Agents
          </Link>
        </div>
        <div className="flex items-start gap-3 rounded-lg border border-[var(--line)] bg-[var(--paper)] px-4 py-3">
          <MessageSquareText size={15} className="mt-0.5 shrink-0 text-[var(--ink-3)]" />
          <div className="min-w-0 flex-1">
            <p className="text-[13px] text-[var(--ink)]">2. Ask it to write something</p>
            <p className="mt-1.5 select-text rounded bg-[var(--paper-2)] px-2.5 py-2 text-[12px] leading-relaxed text-[var(--ink-2)]">
              {FIRST_WRITE_PROMPT}
            </p>
            <Button size="sm" variant="secondary" className="mt-2 h-7 gap-1.5 text-[12px]" onPress={() => void copyPrompt()}>
              <Copy size={12} /> Copy prompt
            </Button>
          </div>
        </div>
        <p className="mt-1 text-center text-[11.5px] text-[var(--ink-mute)]">
          No agent at hand?{" "}
          <button
            type="button"
            onClick={() => window.dispatchEvent(new CustomEvent("bcontext:new-node"))}
            className="underline underline-offset-2 hover:text-[var(--ink-3)]"
          >
            Create a node by hand
          </button>
        </p>
      </EmptyState.Content>
    </EmptyState>
  );
}
