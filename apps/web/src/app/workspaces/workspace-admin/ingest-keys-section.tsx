"use client";

/**
 * Ingest keys: the write-only keys a SaaS app sends its customers, money and
 * usage to Bcontext with. Rendered by `workspace-admin-modal.tsx` for those
 * who manage the workspace; reads and writes
 * `/api/workspaces/<slug>/ingest-keys` through `@/lib/business/client`.
 *
 * A key's secret is shown once, right after it is created, with a copy
 * button — the API stores only its hash, so there is no "show again". Below
 * the list, a short "how to send data" panel with curl examples
 * (`@/lib/business/ingest-examples`, written from the ingest API docs) so
 * the person who just made a key can use it without leaving the dialog. The
 * examples follow the workspace's business model (a marketplace sees a
 * booking, not a subscription), read here from its business settings: the
 * dialog also opens from the workspaces list, outside the shell's context.
 *
 * Revoking is one press away from stopping an app's data, and cannot be
 * undone, so "Revoke" first turns its row into an inline confirmation
 * (what stops, Cancel / Revoke key) — in the page, not `window.confirm`,
 * which this dialog cannot style and a phone shows out of context.
 *
 * Must not break: the plaintext never outlives this component's state —
 * not in a URL, not in storage, not in a log.
 */
import { useCallback, useEffect, useState } from "react";
import { Check, Copy, Plus } from "lucide-react";
import { Alert, Button, Chip, Input, Label, Skeleton, TextField } from "@heroui/react";
import type { IngestKey } from "@bcontext-dev/contract/business/ingest";
import type { BusinessModel } from "@bcontext-dev/contract/business/record-types";
import { createIngestKey, fetchBusinessSettings, fetchIngestKeys, revokeIngestKey } from "@/lib/business/client";
import { ingestExamples } from "@/lib/business/ingest-examples";
import { Block, SectionHead, relAgo } from "./panel-ui";

export function IngestKeysSection({ slug }: { slug: string }) {
  const [keys, setKeys] = useState<IngestKey[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [secret, setSecret] = useState<{ name: string; key: string } | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  /** The key whose row is asking "revoke it?" — one at a time. */
  const [confirming, setConfirming] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [origin, setOrigin] = useState("https://your-bcontext");
  /** The business model the examples are for; `null` until the settings answered (or failed). */
  const [model, setModel] = useState<BusinessModel | undefined | null>(null);

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      setKeys(await fetchIngestKeys(slug));
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "Couldn't load the keys.");
    }
  }, [slug]);

  useEffect(() => {
    void load();
    // Client components reach the API through this origin's proxy, so the
    // examples are written against it too.
    setOrigin(window.location.origin);
  }, [load]);

  useEffect(() => {
    let live = true;
    // Without settings (an older API, a failed read) the b2b examples stay:
    // they are still correct calls, only not the closest ones.
    fetchBusinessSettings(slug)
      .then((settings) => {
        if (live) setModel(settings?.business_model);
      })
      .catch(() => {
        if (live) setModel(undefined);
      });
    return () => {
      live = false;
    };
  }, [slug]);

  async function create() {
    const trimmed = name.trim();
    if (!trimmed || pending) return;
    setPending("create");
    setError(null);
    try {
      const result = await createIngestKey(slug, trimmed);
      setSecret({ name: result.record.name, key: result.key });
      setName("");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't create the key.");
    } finally {
      setPending(null);
    }
  }

  async function revoke(key: IngestKey) {
    setPending(key.id);
    setError(null);
    try {
      await revokeIngestKey(slug, key.id);
      setConfirming(null);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't revoke the key.");
    } finally {
      setPending(null);
    }
  }

  const active = (keys ?? []).filter((key) => !key.revoked_at);
  const revoked = (keys ?? []).filter((key) => key.revoked_at);
  // Skeletons until the model is known, so a marketplace never flashes a
  // subscription example first.
  const examples = model === null ? null : ingestExamples({ origin, slug, key: secret?.key, model });

  return (
    <div>
      <SectionHead
        title="Ingest keys"
        hint="Write-only keys your app sends customers, subscriptions, bookings and expenses with. They cannot read anything — not even what they wrote."
      />

      <Block title="New key" hint="One per app or environment, so one can be revoked without stopping the others.">
        <form
          className="flex max-w-md items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void create();
          }}
        >
          <TextField value={name} onChange={setName} isDisabled={pending !== null} maxLength={80} className="min-w-0 flex-1">
            <Label>Name</Label>
            <Input placeholder="Production backend" className="w-full min-w-0" />
          </TextField>
          <Button type="submit" isDisabled={!name.trim() || pending !== null} isPending={pending === "create"}>
            <Plus size={13} /> Create
          </Button>
        </form>
      </Block>

      {secret ? (
        <div role="status" className="mb-8 rounded-[10px] border border-warning/50 bg-warning/10 p-4">
          <div className="text-[13px] font-medium text-foreground">Copy “{secret.name}” now — it will not be shown again.</div>
          <div className="mt-2 flex items-center gap-2">
            <code className="min-w-0 flex-1 truncate rounded-md border border-border bg-[var(--paper)] px-2.5 py-1.5 font-mono text-[12px]">{secret.key}</code>
            <CopyButton text={secret.key} label="Copy key" />
          </div>
          <Button size="sm" variant="ghost" className="mt-2" onPress={() => setSecret(null)}>I have stored it</Button>
        </div>
      ) : null}

      {error ? (
        <Alert role="alert" status="danger" className="mb-4">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Description>{error}</Alert.Description>
          </Alert.Content>
        </Alert>
      ) : null}

      <Block title="Keys">
        {loadError ? (
          <p role="alert" className="text-[13px] text-danger">{loadError}</p>
        ) : !keys ? (
          <Skeleton className="h-[60px] rounded-[10px]" />
        ) : active.length === 0 && revoked.length === 0 ? (
          <p className="text-[12.5px] text-muted">No keys yet.</p>
        ) : (
          <ul className="divide-y divide-border overflow-hidden rounded-[10px] border border-border">
            {[...active, ...revoked].map((key) => (
              <li key={key.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-[13px] text-foreground">{key.name}</span>
                    {key.revoked_at ? <Chip size="sm" variant="soft" color="danger"><Chip.Label>Revoked</Chip.Label></Chip> : null}
                  </div>
                  <div className="mt-0.5 font-mono text-[11.5px] text-muted">
                    {key.prefix}…{key.last4} · created {relAgo(key.created_at)} · {key.last_used_at ? `last used ${relAgo(key.last_used_at)}` : "never used"}
                  </div>
                </div>
                {!key.revoked_at && confirming !== key.id ? (
                  <Button size="sm" variant="ghost" className="text-danger" isDisabled={pending !== null} onPress={() => setConfirming(key.id)}>
                    Revoke
                  </Button>
                ) : null}
                {!key.revoked_at && confirming === key.id ? (
                  <div role="group" aria-label={`Revoke ${key.name}?`} className="flex w-full flex-wrap items-center gap-2 rounded-[8px] border border-danger/40 bg-danger/5 px-3 py-2">
                    <span className="min-w-0 flex-1 text-[12.5px] text-foreground">
                      Revoke “{key.name}”? Anything sending with it is refused from now on. This cannot be undone.
                    </span>
                    <Button size="sm" variant="ghost" isDisabled={pending !== null} onPress={() => setConfirming(null)}>
                      Cancel
                    </Button>
                    <Button size="sm" variant="danger" isPending={pending === key.id} isDisabled={pending !== null} onPress={() => void revoke(key)}>
                      Revoke key
                    </Button>
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </Block>

      <Block title="How to send data" hint="Send the key as a bearer token. Every call is idempotent on the key you choose, so retries are safe.">
        <div className="space-y-4">
          {examples === null ? (
            <>
              <Skeleton className="h-4 w-40 rounded-md" />
              <Skeleton className="h-32 w-full rounded-[10px]" />
            </>
          ) : examples.map((example) => (
            <div key={example.title}>
              <div className="mb-1 flex items-center justify-between gap-2">
                <span className="text-[12.5px] font-medium text-foreground">{example.title}</span>
                <CopyButton text={example.command} label={`Copy: ${example.title}`} />
              </div>
              <p className="mb-1.5 text-[12px] text-muted">{example.note}</p>
              <pre className="scroll overflow-x-auto rounded-[10px] border border-border bg-[var(--paper-2)] p-3 font-mono text-[11.5px] leading-[1.55] text-foreground">{example.command}</pre>
            </div>
          ))}
        </div>
      </Block>
    </div>
  );
}

function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1600);
    return () => clearTimeout(timer);
  }, [copied]);
  return (
    <Button
      size="sm"
      variant="ghost"
      isIconOnly
      aria-label={copied ? "Copied" : label}
      onPress={() => {
        void navigator.clipboard?.writeText(text).then(() => setCopied(true)).catch(() => {});
      }}
    >
      {copied ? <Check size={13} /> : <Copy size={13} />}
    </Button>
  );
}
