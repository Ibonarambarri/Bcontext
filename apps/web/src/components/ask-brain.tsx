"use client";

/**
 * "Ask the brain…" — the question box in the workspace header, mounted by
 * `workspace-shell.tsx` on every workspace page. The answer opens in a
 * dialog over the page, with each `[N]` citation and each source a button
 * that opens that node in the floating panel.
 *
 * Calls `POST /api/ask` (the REST face of the MCP `ask_rag` tool: same
 * retrieval, same synthesis prompt). Not streamed — the endpoint answers in
 * one short model call. The ⌘K palette hands a typed query over with the
 * `bcontext:ask` window event (`ASK_EVENT`, `lib/ask.ts`, with the hints).
 *
 * What must not break: a self-hosted stack with no model key answers with
 * sources and `synthesis: "no_model"`; that is a one-line hint above the
 * sources, never an error and never a toast. A failed request is an inline
 * message in the dialog, for the same reason: the box is on every page.
 */
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { ArrowUp, Info, Loader2, Sparkles } from "lucide-react";
import { Button, Input, Modal } from "@heroui/react";
import {
  ASK_MAX_QUERY,
  splitAnswerCitations,
  type AskResponse,
  type AskSource,
} from "@bcontext-dev/contract/ask";
import { ASK_EVENT, synthesisHint } from "@/lib/ask";
import { workspaceApiRef } from "@/web/workspace-url";
import { NODE_KIND_ICONS } from "./node-kind-icon";
import { useWorkspace } from "./workspace-context";

type AskState =
  | { status: "idle" }
  | { status: "loading"; query: string }
  | { status: "done"; response: AskResponse }
  | { status: "error"; query: string; message: string };

export function AskBrain() {
  const { address } = useWorkspace();
  const [draft, setDraft] = useState("");
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<AskState>({ status: "idle" });
  const request = useRef<AbortController | null>(null);

  const ask = useCallback(async (raw: string) => {
    const query = raw.trim().slice(0, ASK_MAX_QUERY);
    if (!query) return;
    setOpen(true);
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setState({ status: "loading", query });
    try {
      const response = await fetch("/api/ask", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workspace: workspaceApiRef(address), query }),
        signal: controller.signal,
      });
      if (!response.ok) {
        setState({
          status: "error",
          query,
          message: response.status === 403
            ? "You don't have access to ask this workspace."
            : "The brain could not be asked just now. Try again in a moment.",
        });
        return;
      }
      setState({ status: "done", response: await response.json() as AskResponse });
    } catch (err) {
      if ((err as { name?: string }).name === "AbortError") return;
      setState({ status: "error", query, message: "The brain could not be reached. Check your connection." });
    }
  }, [address]);

  useEffect(() => {
    function onAsk(event: Event) {
      const query = (event as CustomEvent<{ query?: string }>).detail?.query ?? "";
      setDraft(query);
      if (query.trim()) void ask(query);
      else setOpen(true);
    }
    window.addEventListener(ASK_EVENT, onAsk);
    return () => window.removeEventListener(ASK_EVENT, onAsk);
  }, [ask]);

  useEffect(() => () => request.current?.abort(), []);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    void ask(draft);
  };

  return (
    <>
      {/* Header input from sm up; a single icon under it, where the header
          row has no room for a field. Both lead to the same dialog. */}
      <form role="search" aria-label="Ask the brain" onSubmit={submit} className="hidden w-full max-w-sm items-center sm:flex">
        <div className="relative w-full">
          <Sparkles size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--ink-3)]" aria-hidden />
          <Input
            aria-label="Ask the brain"
            placeholder="Ask the brain…"
            value={draft}
            maxLength={ASK_MAX_QUERY}
            onChange={(event) => setDraft(event.target.value)}
            className="h-8 w-full pl-8 text-[13px]"
          />
        </div>
      </form>
      <Button isIconOnly size="sm" variant="ghost" aria-label="Ask the brain" className="sm:hidden" onPress={() => setOpen(true)}>
        <Sparkles size={15} />
      </Button>

      <Modal.Backdrop isOpen={open} onOpenChange={setOpen}>
        <Modal.Container placement="top" size="md" scroll="inside" className="pt-[8vh]">
          <Modal.Dialog aria-label="Ask the brain" className="sm:max-w-[680px]">
            <Modal.CloseTrigger />
            <Modal.Header>
              <Modal.Heading className="flex items-center gap-2 text-[15px]">
                <Sparkles size={15} /> Ask the brain
              </Modal.Heading>
            </Modal.Header>
            <Modal.Body className="flex flex-col gap-4">
              <form onSubmit={submit} className="flex items-center gap-2">
                <Input
                  autoFocus
                  aria-label="Your question"
                  placeholder="What did we decide about…"
                  value={draft}
                  maxLength={ASK_MAX_QUERY}
                  onChange={(event) => setDraft(event.target.value)}
                  className="w-full text-[13.5px]"
                />
                <Button type="submit" isIconOnly aria-label="Ask" isDisabled={!draft.trim() || state.status === "loading"}>
                  {state.status === "loading" ? <Loader2 size={15} className="animate-spin" /> : <ArrowUp size={15} />}
                </Button>
              </form>
              <AskResult state={state} onOpenNode={() => setOpen(false)} />
            </Modal.Body>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </>
  );
}

function AskResult({ state, onOpenNode }: { state: AskState; onOpenNode: () => void }) {
  const { selectNode } = useWorkspace();
  const openSource = useCallback((source: AskSource) => {
    onOpenNode();
    selectNode(source.node_id, { blockId: source.block_id });
  }, [onOpenNode, selectNode]);

  if (state.status === "idle") {
    return (
      <p className="text-[12.5px] text-muted">
        Answers come from this workspace only, with links to the nodes they cite.
      </p>
    );
  }
  if (state.status === "loading") {
    return (
      <div className="flex items-center gap-2 text-[12.5px] text-muted" aria-live="polite">
        <Loader2 size={14} className="animate-spin" /> Reading the brain…
      </div>
    );
  }
  if (state.status === "error") {
    return <p className="text-[12.5px] text-[var(--ink-3)]" role="status">{state.message}</p>;
  }

  const { response } = state;
  const hint = synthesisHint(response);
  return (
    <div className="flex flex-col gap-4" aria-live="polite">
      {response.answer ? (
        <div className="whitespace-pre-wrap text-[13.5px] leading-relaxed text-[var(--ink)]">
          {splitAnswerCitations(response.answer, response.sources.length).map((part, index) =>
            part.type === "text" ? (
              <span key={index}>{part.text}</span>
            ) : (
              <button
                key={index}
                type="button"
                onClick={() => openSource(response.sources[part.n - 1]!)}
                title={response.sources[part.n - 1]?.title}
                className="mx-0.5 inline-flex h-4 min-w-4 items-center justify-center rounded bg-[var(--paper-2)] px-1 align-text-top text-[10px] font-medium text-[var(--ink-2)] hover:bg-[var(--line)]"
              >
                {part.n}
              </button>
            ),
          )}
        </div>
      ) : null}
      {hint ? (
        <p className="flex items-start gap-2 text-[12px] text-muted">
          <Info size={13} className="mt-0.5 shrink-0" aria-hidden /> {hint}
        </p>
      ) : null}
      {response.sources.length > 0 ? (
        <section aria-label="Sources">
          <h3 className="mono mb-1.5 text-[10px] uppercase tracking-wider text-[var(--ink-mute)]">Sources</h3>
          <ol className="flex flex-col divide-y divide-[var(--line)] rounded-lg border border-[var(--line)]">
            {response.sources.map((source) => {
              const Icon = NODE_KIND_ICONS[source.kind];
              return (
                <li key={`${source.n}-${source.node_id}`}>
                  <button
                    type="button"
                    onClick={() => openSource(source)}
                    className="flex w-full items-start gap-2.5 px-3 py-2 text-left hover:bg-[var(--paper-2)]"
                  >
                    <span className="mono mt-0.5 w-4 shrink-0 text-[11px] text-[var(--ink-mute)]">{source.n}</span>
                    {Icon ? <Icon size={14} className="mt-0.5 shrink-0 text-[var(--ink-3)]" /> : null}
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13px] text-[var(--ink)]">
                        {source.title}
                        {source.superseded_by ? <span className="ml-2 text-[11px] text-muted">superseded</span> : source.stale ? <span className="ml-2 text-[11px] text-muted">may be stale</span> : null}
                      </span>
                      {source.snippet ? (
                        <span className="mt-0.5 line-clamp-2 block text-[11.5px] text-muted">{source.snippet}</span>
                      ) : null}
                    </span>
                  </button>
                </li>
              );
            })}
          </ol>
        </section>
      ) : null}
    </div>
  );
}
