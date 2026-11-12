/**
 * "Ask the brain" — the web's question box over the same cited retrieval the
 * MCP `ask_rag` tool runs.
 *
 * `POST /api/ask` answers with `AskResponse`; the web's ask box renders it.
 * The answer cites its sources inline as `[N]`, where N is a 1-based index
 * into `sources`, exactly as `ask_rag` does for agents, so one synthesis
 * prompt serves both surfaces.
 *
 * What must not break: `synthesis` is never an error. A self-hosted stack
 * without a model key still gets `sources` from the keyword retriever and
 * `synthesis: "no_model"`, and the UI turns that into a hint, not a failure.
 */
import type { NodeKind } from "./types.js";

/** Why there is (or is not) a synthesized answer next to the sources. */
export type AskSynthesis =
  /** A model answered from the sources. */
  | "answered"
  /** No model is configured on this server: sources only. */
  | "no_model"
  /** Nothing in the workspace matched, so there was nothing to answer from. */
  | "no_hits"
  /** The model call failed; the sources are still authoritative. */
  | "failed";

export interface AskSource {
  /** 1-based; the `[N]` markers in `answer` point here. */
  n: number;
  node_id: string;
  title: string;
  kind: NodeKind;
  block_id: string | null;
  snippet: string | null;
  /** Labeled, never hidden: a stale or superseded hit is still a source. */
  stale?: boolean;
  superseded_by?: string | null;
}

export interface AskRequest {
  workspace: string;
  query: string;
  k?: number;
}

export interface AskResponse {
  query: string;
  answer: string | null;
  synthesis: AskSynthesis;
  sources: AskSource[];
}

/** Longest question the endpoint accepts; the MCP tool has the same cap. */
export const ASK_MAX_QUERY = 2000;

export type AnswerPart =
  | { type: "text"; text: string }
  | { type: "cite"; n: number };

/**
 * Split an answer into text and `[N]` citation parts so the UI can render
 * each citation as a link to its source. Grouped markers (`[1, 3]`, `[1][2]`)
 * become one part per number. A number with no matching source stays as
 * plain text: a model that cites `[9]` out of six sources must not produce a
 * link to nothing.
 */
export function splitAnswerCitations(answer: string, sourceCount: number): AnswerPart[] {
  const parts: AnswerPart[] = [];
  const pattern = /\[(\d+(?:\s*,\s*\d+)*)\]/g;
  let last = 0;
  const pushText = (text: string) => {
    if (!text) return;
    const prev = parts[parts.length - 1];
    if (prev?.type === "text") prev.text += text;
    else parts.push({ type: "text", text });
  };
  for (const match of answer.matchAll(pattern)) {
    const index = match.index ?? 0;
    pushText(answer.slice(last, index));
    const numbers = match[1]!.split(",").map((value) => Number(value.trim()));
    if (numbers.every((n) => Number.isInteger(n) && n >= 1 && n <= sourceCount)) {
      for (const n of numbers) parts.push({ type: "cite", n });
    } else {
      pushText(match[0]);
    }
    last = index + match[0].length;
  }
  pushText(answer.slice(last));
  return parts;
}
