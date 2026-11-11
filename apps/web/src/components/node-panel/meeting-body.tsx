"use client";

/**
 * The body of a meeting in the panel — the compact counterpart of
 * `agents/meeting-node-view.tsx`, built from the same pieces:
 *
 *   · no transcript yet → `MeetingEmptyState` (paste one) above the notes;
 *   · a transcript → the Refined / Transcript selector (`MeetingViewSelector`,
 *     with refine status and retry), the transcript rendered read-only —
 *     it is the meeting's source record and never edited — and the refined
 *     notes as the editable prose.
 *
 * The refine job's completion reaches the panel as a `node.updated`
 * broadcast: the inspector reloads, `data.refine_status` changes and the
 * selector updates itself. The selector's own `router.refresh()` is
 * harmless here.
 */

import { useState } from "react";
import { MeetingEmptyState } from "@/components/agents/meeting-empty-state";
import { MeetingViewSelector } from "@/components/agents/meeting-view-selector";
import { NodeMarkdown } from "@/components/node-markdown";
import { resolveDefaultView, type MeetingView } from "@/lib/meetings/view";
import type { RefineStatus } from "@bcontext-dev/contract/meetings";
import { PanelProse } from "./prose-body";
import type { PanelBodyProps } from "./panel-body";

interface MeetingData {
  transcript_md?: string;
  refine_status?: RefineStatus;
  refine_error?: string | null;
}

export function MeetingBody(props: PanelBodyProps) {
  const { payload, openNode } = props;
  const node = payload.node;
  const data = (node.data ?? {}) as MeetingData;
  const transcript = data.transcript_md ?? "";
  const hasTranscript = transcript.trim().length > 0;
  const [view, setView] = useState<MeetingView>(() => resolveDefaultView(data.refine_status, hasTranscript));

  if (!hasTranscript) {
    return (
      <div className="flex flex-col gap-2">
        <MeetingEmptyState nodeId={node.id} />
        <PanelProse {...props} />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="-mt-3">
        <MeetingViewSelector
          view={view}
          status={data.refine_status}
          refineError={data.refine_error ?? null}
          nodeId={node.id}
          onChange={setView}
        />
      </div>
      {view === "transcript" ? (
        <NodeMarkdown markdown={transcript} onOpenNode={openNode} className="prose-meeting" />
      ) : (
        <PanelProse {...props} />
      )}
    </div>
  );
}
