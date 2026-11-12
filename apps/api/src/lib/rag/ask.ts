/**
 * Answer a question from retrieved hits, citing each claim as `[N]`.
 *
 * Shared by the MCP `ask_rag` tool and `POST /api/ask` (the web's "Ask the
 * brain" box), so agents and people get the same answer from the same
 * prompt. Retrieval happens before this (`retrieveScoped`, which already
 * bounds the hits by the caller's reach); this module only synthesizes.
 *
 * What must not break: synthesis never throws. No model configured, no hits
 * or a failed model call each come back as a status with `answer: null`, and
 * the caller still returns the hits — retrieval must never fail because
 * synthesis did.
 */
import { chatModel } from "@/lib/ai/models";
import { aiConfigured, languageModel } from "@/lib/ai/provider";
import { refForHit, type RagHit } from "@/lib/rag";
import { recordAiUsageEvent, tokensFromUsage } from "@/lib/telemetry/ai-usage";
import type { AskSynthesis } from "@bcontext-dev/contract/ask";

export const ASK_SYSTEM_PROMPT =
  "Answer strictly from the numbered context blocks. Cite every factual claim with its [N] marker inline. If the context doesn't answer the question, say so — never invent. Be concise (under 200 words).";

export interface SynthesisResult {
  answer: string | null;
  synthesis: AskSynthesis;
}

export async function synthesizeAnswer(args: {
  query: string;
  hits: RagHit[];
  /** Set when the workspace is persisted, so the model call is metered. */
  usage?: { workspaceId: string; subjectUserId: string | null; surface: "ask_rag" } | null;
}): Promise<SynthesisResult> {
  const { query, hits } = args;
  if (hits.length === 0) return { answer: null, synthesis: "no_hits" };
  if (!aiConfigured()) return { answer: null, synthesis: "no_model" };
  try {
    const { generateText } = await import("ai");
    const model = chatModel();
    const context = hits
      .map(
        (h, i) =>
          `[${i + 1}] ${h.kind.toUpperCase()} · ${h.title} (${refForHit(h)})\n${(h.content ?? "").trim().slice(0, 1500)}`,
      )
      .join("\n\n---\n\n");
    const result = await generateText({
      model: languageModel(model),
      system: ASK_SYSTEM_PROMPT,
      prompt: `Question: ${query}\n\nContext:\n${context}`,
    });
    if (args.usage) {
      void recordAiUsageEvent({
        workspaceId: args.usage.workspaceId,
        subjectUserId: args.usage.subjectUserId,
        surface: args.usage.surface,
        model,
        tokens: tokensFromUsage(result.usage),
      });
    }
    return { answer: result.text, synthesis: "answered" };
  } catch (err) {
    console.warn("[rag] ask synthesis failed:", err);
    return { answer: null, synthesis: "failed" };
  }
}
