/**
 * The ask box's copy for each synthesis outcome — what the person reads when
 * there is no written answer. Called by `components/ask-brain.tsx`; kept here
 * so it is testable without rendering the dialog.
 *
 * What must not break: `no_model` (a self-hosted stack with no model key) is
 * a hint, never an error. The sources under it are the useful part.
 */
import type { AskResponse } from "@bcontext-dev/contract/ask";

/** Window event: `new CustomEvent(ASK_EVENT, { detail: { query } })` opens the box and asks. */
export const ASK_EVENT = "bcontext:ask";

export function synthesisHint(response: Pick<AskResponse, "synthesis">): string | null {
  switch (response.synthesis) {
    case "answered":
      return null;
    case "no_model":
      return "No AI model is configured on this server, so these are the closest nodes instead of a written answer.";
    case "no_hits":
      return "Nothing in this workspace matches that yet. Ask your agent to record it.";
    case "failed":
      return "The model could not answer just now; the closest nodes are below.";
  }
}
