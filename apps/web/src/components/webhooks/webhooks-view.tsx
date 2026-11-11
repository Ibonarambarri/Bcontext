"use client";

/**
 * Webhooks — the `webhooks` system view (mounted through
 * `agents-dashboard.tsx`): the workspace's outbound, signed webhook
 * endpoints. Each one receives workspace events as CloudEvents v1.0 signed
 * with HMAC-SHA256 (see `@bcontext-dev/contract/webhooks/events`).
 *
 * Data: `GET /api/webhooks/endpoints`; the workspace id and `can_manage`
 * come from `GET /api/agents/connections`, which is the cheapest read that
 * answers both. Creation goes through `WebhookModal`, the only place the
 * signing secret is ever shown. Pause/resume is optimistic; delete confirms
 * first. Only workspace admins see or manage endpoints.
 */

import { useCallback, useEffect, useState } from "react";
import { Pause, Play, Plus, Send, Trash2, Webhook } from "lucide-react";
import { AlertDialog, Button, Card, Chip } from "@heroui/react";
import { EmptyState } from "@/components/ui/empty-state";
import { CardActionsMenu } from "@/components/card-actions-menu";
import { GridSkeleton } from "@/components/skeletons";
import { useToast } from "@/components/workspace-context";
import { formatRelative } from "@bcontext-dev/contract/utils";
import { WebhookModal, type WebhookEndpointRow } from "./webhook-modal";
import { workspaceApiRef, type WorkspaceAddress } from "@/web/workspace-url";

export function WebhooksView({ workspace }: { workspace: WorkspaceAddress }) {
  const toast = useToast();
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);
  const [webhooks, setWebhooks] = useState<WebhookEndpointRow[]>([]);
  const [canManage, setCanManage] = useState(false);
  const [adding, setAdding] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<WebhookEndpointRow | null>(null);

  const loadWebhooks = useCallback(async (wsId: string) => {
    const response = await fetch(`/api/webhooks/endpoints?workspace_id=${encodeURIComponent(wsId)}`, { cache: "no-store" });
    const body = (await response.json().catch(() => ({}))) as { endpoints?: WebhookEndpointRow[]; message?: string };
    if (!response.ok) throw new Error(body.message ?? `HTTP ${response.status}`);
    // Most recent activity first.
    const activity = (row: WebhookEndpointRow) => Date.parse(row.last_delivery_at ?? row.created_at);
    setWebhooks((body.endpoints ?? []).toSorted((left, right) => activity(right) - activity(left)));
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const identityResponse = await fetch(`/api/agents/connections?workspace=${encodeURIComponent(workspaceApiRef(workspace))}`, { cache: "no-store" });
      const identity = (await identityResponse.json().catch(() => ({}))) as {
        workspace?: { id: string };
        can_manage?: boolean;
        message?: string;
      };
      if (!identityResponse.ok || !identity.workspace?.id) {
        throw new Error(identity.message ?? `HTTP ${identityResponse.status}`);
      }
      setWorkspaceId(identity.workspace.id);
      setCanManage(Boolean(identity.can_manage));
      if (!identity.can_manage) {
        setWebhooks([]);
        return;
      }
      await loadWebhooks(identity.workspace.id);
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setLoading(false);
    }
  }, [loadWebhooks, workspace]);

  useEffect(() => { void load(); }, [load]);

  const refresh = useCallback(() => {
    if (workspaceId) void loadWebhooks(workspaceId).catch((cause) => setError((cause as Error).message));
  }, [loadWebhooks, workspaceId]);

  async function testWebhook(endpoint: WebhookEndpointRow) {
    setError(null);
    try {
      const response = await fetch(`/api/webhooks/endpoints/${endpoint.id}`, { method: "POST" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      setNotice(`Test event queued for ${hostOf(endpoint.url)}.`);
    } catch (cause) {
      setError((cause as Error).message);
    }
  }

  async function togglePause(endpoint: WebhookEndpointRow) {
    // Optimistic (repo convention): flip paused locally, reconcile with the
    // canonical list in the background, revert + toast on failure.
    const previous = webhooks;
    setWebhooks((current) =>
      current.map((item) => (item.id === endpoint.id ? { ...item, paused: !endpoint.paused } : item)),
    );
    setError(null);
    try {
      const response = await fetch(`/api/webhooks/endpoints/${endpoint.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ paused: !endpoint.paused }),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      refresh();
    } catch (cause) {
      setWebhooks(previous);
      toast.error(`Couldn’t ${endpoint.paused ? "resume" : "pause"} the webhook: ${(cause as Error).message}`);
    }
  }

  async function remove(endpoint: WebhookEndpointRow) {
    setSaving(true);
    setError(null);
    try {
      const response = await fetch(`/api/webhooks/endpoints/${endpoint.id}`, { method: "DELETE" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      setDeleting(null);
      refresh();
      setNotice("Webhook endpoint deleted.");
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setSaving(false);
    }
  }

  const startAdd = () => { setError(null); setNotice(null); setAdding(true); };

  return (
    <section className="mb-9">
      <div className="mt-4 flex flex-wrap items-end gap-3">
        <div>
          <h2 className="m-0 text-[15px] font-medium">Webhooks</h2>
          <p className="mt-0.5 text-[12px] text-[var(--ink-3)]">
            {loading ? "Workspace events, delivered to your URL and signed." : `${webhooks.length} endpoint${webhooks.length === 1 ? "" : "s"} · sorted by last delivery`}
          </p>
        </div>
        <span className="ml-auto" />
        {canManage ? (
          <Button size="sm" className="gap-1.5" onPress={startAdd}>
            <Plus size={14} /> Add webhook
          </Button>
        ) : null}
      </div>

      {notice ? <p className="my-3 rounded-md border border-[var(--accent)]/25 bg-[var(--accent-2)] px-3 py-2 text-[11.5px] text-[var(--accent)]">{notice}</p> : null}
      {error && !adding ? <p className="my-3 text-[12px] text-danger">{error}</p> : null}

      {loading ? <GridSkeleton cards={3} minHeightClassName="min-h-[120px]" label="Loading webhooks" /> : null}
      {!loading && !canManage ? (
        <div className="mt-5 rounded-[12px] border border-[var(--line)] bg-[var(--paper-2)] p-5 text-[12px] text-[var(--ink-3)]">
          Workspace admins manage webhook endpoints.
        </div>
      ) : null}
      {!loading && canManage && webhooks.length > 0 ? (
        <div className="mt-5 grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
          {webhooks.map((endpoint) => (
            <WebhookCard
              key={endpoint.id}
              endpoint={endpoint}
              saving={saving}
              onTest={() => void testWebhook(endpoint)}
              onTogglePause={() => void togglePause(endpoint)}
              onDelete={() => setDeleting(endpoint)}
            />
          ))}
        </div>
      ) : null}
      {!loading && canManage && webhooks.length === 0 ? <EmptyWebhooks onAdd={startAdd} /> : null}

      {adding && workspaceId ? (
        <WebhookModal workspaceId={workspaceId} onClose={() => setAdding(false)} onCreated={refresh} />
      ) : null}
      {deleting ? (
        <DeleteWebhookDialog endpoint={deleting} saving={saving} onClose={() => setDeleting(null)} onConfirm={() => void remove(deleting)} />
      ) : null}
    </section>
  );
}

function WebhookCard({ endpoint, saving, onTest, onTogglePause, onDelete }: {
  endpoint: WebhookEndpointRow;
  saving: boolean;
  onTest: () => void;
  onTogglePause: () => void;
  onDelete: () => void;
}) {
  const host = hostOf(endpoint.url);
  const live = !endpoint.paused;
  return (
    <Card className="group flex min-h-[120px] flex-col gap-0 rounded-[12px] border border-[var(--line)] bg-[var(--paper)] p-4 shadow-none transition-colors hover:border-[var(--ink-mute)]">
      <Card.Header className="flex-row items-center gap-3 p-0">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[10px] border border-[var(--line)] bg-[var(--paper-2)]">
          <Webhook size={18} />
        </div>
        <Card.Title className="min-w-0 flex-1 truncate text-[14px] font-medium leading-tight text-[var(--ink)]">{host}</Card.Title>
        <Chip size="sm" variant="soft" className="shrink-0 gap-1.5 capitalize">
          <span className="h-1.5 w-1.5 rounded-full" style={{ background: live ? "var(--success)" : "var(--ink-mute)" }} />
          {live ? "live" : "paused"}
        </Chip>
        <CardActionsMenu
          ariaLabel={`Actions for ${host}`}
          isDisabled={saving}
          actions={[
            { id: "test", label: "Send test event", Icon: Send },
            { id: "toggle", label: endpoint.paused ? "Resume" : "Pause", Icon: endpoint.paused ? Play : Pause },
            { id: "delete", label: "Delete", Icon: Trash2, danger: true },
          ]}
          onAction={(key) => {
            if (key === "test") onTest();
            else if (key === "toggle") onTogglePause();
            else if (key === "delete") onDelete();
          }}
        />
      </Card.Header>
      <Card.Footer className="mt-auto flex items-center gap-2 border-t border-[var(--line)] p-0 pt-3">
        <span className="font-mono text-[10px] text-[var(--ink-3)]">{endpoint.event_types.length} event{endpoint.event_types.length === 1 ? "" : "s"}</span>
        <span className="ml-auto min-w-0 truncate font-mono text-[10px] text-[var(--ink-mute)]">
          {endpoint.last_delivery_at ? `delivered ${formatRelative(endpoint.last_delivery_at)}` : "no deliveries yet"}
        </span>
      </Card.Footer>
    </Card>
  );
}

function DeleteWebhookDialog({ endpoint, saving, onClose, onConfirm }: {
  endpoint: WebhookEndpointRow;
  saving: boolean;
  onClose: () => void;
  onConfirm: () => void;
}) {
  return (
    <AlertDialog.Backdrop isOpen onOpenChange={(next) => { if (!next && !saving) onClose(); }}>
      <AlertDialog.Container placement="center">
        <AlertDialog.Dialog aria-labelledby="delete-webhook-title" className="w-full max-w-[440px]">
          <AlertDialog.Header className="flex-col items-start gap-0">
            <AlertDialog.Icon status="danger">
              <Trash2 size={15} />
            </AlertDialog.Icon>
            <AlertDialog.Heading id="delete-webhook-title" className="mt-4 text-[15px] font-medium">Delete this webhook endpoint?</AlertDialog.Heading>
          </AlertDialog.Header>
          <AlertDialog.Body>
            <p className="mt-1 break-all font-mono text-[10.5px] text-[var(--ink-2)]">{endpoint.url}</p>
            <p className="mt-2 text-[11.5px] leading-relaxed text-muted">Event deliveries to this URL stop immediately and its signing secret is revoked. This cannot be undone.</p>
          </AlertDialog.Body>
          <AlertDialog.Footer className="flex">
            <Button isDisabled={saving} onPress={onClose} variant="outline" size="sm">Cancel</Button>
            <Button isDisabled={saving} onPress={onConfirm} variant="danger" size="sm" className="ml-auto gap-1.5"><Trash2 size={11} />{saving ? "Deleting…" : "Delete endpoint"}</Button>
          </AlertDialog.Footer>
        </AlertDialog.Dialog>
      </AlertDialog.Container>
    </AlertDialog.Backdrop>
  );
}

function EmptyWebhooks({ onAdd }: { onAdd: () => void }) {
  return (
    <EmptyState className="mt-5 min-h-[260px] rounded-[12px] border border-dashed border-[var(--line)] bg-[var(--paper-2)]">
      <EmptyState.Header>
        <EmptyState.Media variant="icon">
          <Webhook size={18} />
        </EmptyState.Media>
        <EmptyState.Title>No webhooks yet</EmptyState.Title>
        <EmptyState.Description className="max-w-[430px]">
          Deliver workspace events (nodes created, updated, deleted…) to your URL as
          CloudEvents v1.0 signed with HMAC-SHA256, with a dead-letter queue on failure.
        </EmptyState.Description>
      </EmptyState.Header>
      <EmptyState.Content>
        <Button onPress={onAdd} size="sm" className="gap-1.5">
          <Plus size={11} /> Add webhook
        </Button>
      </EmptyState.Content>
    </EmptyState>
  );
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}
