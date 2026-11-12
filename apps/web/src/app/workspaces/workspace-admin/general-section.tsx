"use client";

/**
 * The workspace's identity: what it is called and the colour it is
 * recognised by. Rendered by `workspace-admin-modal.tsx`; writes
 * `PATCH /api/workspaces/<slug>` with a `WorkspacePatch`.
 *
 * The address is not on this screen. A workspace's slug and its `/w/…` path
 * are fixed at creation, unclickable here, and read as machine residue in a
 * section whose whole subject is the human-facing name — people and agents
 * have written them down, which is exactly why nothing here can change them.
 *
 * The save stays disabled until something differs from what was loaded,
 * because the honest state of a form nobody has touched is "nothing to do".
 * Failures are shown in the API's own words.
 *
 * Must not break: someone who does not manage the workspace sees what their
 * role allows instead of a form the API would refuse.
 */

import { useEffect, useState } from "react";
import { Shield } from "lucide-react";
import {
  Alert,
  Button,
  Description,
  Input,
  Label,
  TextField,
} from "@heroui/react";
import {
  GRADIENTS,
  gradientCss,
  gradientFor,
} from "@bcontext-dev/contract/workspace-gradients";
import {
  WORKSPACE_NAME_MAX,
  type WorkspacePatch,
  type WorkspaceRole,
} from "@bcontext-dev/contract/workspaces";
import type { Workspace } from "@bcontext-dev/contract/types";
import { workspaceApiRef } from "@/web/workspace-url";
import { Block, SectionHead, apiMessage } from "./panel-ui";

export function GeneralSection({
  slug,
  name: savedName,
  metadata,
  role,
  canManage,
  onSaved,
}: {
  slug: string;
  name: string;
  metadata: Record<string, unknown> | null;
  role: WorkspaceRole;
  canManage: boolean;
  /** The workspace as it is after the write, so the panel's header follows. */
  onSaved: (next: { name: string; metadata: Record<string, unknown> | null }) => void;
}): React.JSX.Element {
  const savedGradient = gradientFor({ slug, metadata }).id;
  const [name, setName] = useState(savedName);
  const [gradientId, setGradientId] = useState<string>(savedGradient);
  const [pending, setPending] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const trimmed = name.trim();
  const dirty = trimmed !== savedName || gradientId !== savedGradient;

  // The confirmation is a note, not a state to be dismissed: it says the
  // write landed and then gets out of the way.
  useEffect(() => {
    if (!saved) return;
    const timer = setTimeout(() => setSaved(false), 2000);
    return () => clearTimeout(timer);
  }, [saved]);

  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (!dirty || pending) return;
    if (!trimmed) {
      setError("The workspace needs a name.");
      return;
    }
    setPending(true);
    setError(null);
    setSaved(false);
    const patch: WorkspacePatch = {};
    if (trimmed !== savedName) patch.name = trimmed;
    if (gradientId !== savedGradient) patch.accent_gradient = gradientId;
    try {
      const res = await fetch(`/api/workspaces/${encodeURIComponent(workspaceApiRef(slug))}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(patch),
      });
      if (!res.ok) {
        setError(await apiMessage(res, "Couldn't save the changes."));
        return;
      }
      const body = (await res.json().catch(() => null)) as { workspace?: Workspace } | null;
      setSaved(true);
      onSaved({
        name: body?.workspace?.name ?? trimmed,
        // The gradient is stored in the workspace's metadata; when the reply
        // does not carry the row, the choice just made is the truth.
        metadata: body?.workspace?.metadata ?? { ...(metadata ?? {}), accent_gradient: gradientId },
      });
    } catch {
      setError("Couldn't reach the server.");
    } finally {
      setPending(false);
    }
  }

  if (!canManage) {
    return (
      <div>
        <SectionHead title="General" hint="What this workspace is called, and the colour it is recognised by." />
        <div className="rounded-[10px] border border-border bg-surface/60 p-3.5">
          <p className="m-0 text-[12.5px] leading-[1.55] text-muted">
            <Shield size={13} className="mr-1.5 inline align-middle" />
            You have <strong className="font-medium capitalize text-foreground">{role}</strong>{" "}
            access. Ask an owner or admin of {savedName} to rename it, change
            its colour, or invite somebody.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div>
      <SectionHead
        title="General"
        hint="What this workspace is called, and the colour it is recognised by."
      />

      <form onSubmit={save} className="max-w-md">
        <Block title="Name">
          <TextField
            value={name}
            onChange={setName}
            isDisabled={pending}
            maxLength={WORKSPACE_NAME_MAX}
            autoComplete="off"
            fullWidth
          >
            <Label>Workspace name</Label>
            <Input autoFocus placeholder="Acme" />
            <Description>
              Shown to every member and every agent connected to it. Changing
              it does not change its address.
            </Description>
          </TextField>
        </Block>

        <Block title="Accent gradient" hint="How this workspace is picked out of a wall of them.">
          <div className="flex flex-wrap gap-2">
            {GRADIENTS.map((g) => {
              const active = g.id === gradientId;
              return (
                <Button
                  key={g.id}
                  type="button"
                  isIconOnly
                  size="sm"
                  variant="ghost"
                  isDisabled={pending}
                  onPress={() => setGradientId(g.id)}
                  aria-label={g.name}
                  aria-pressed={active}
                  className="h-7 w-7 min-w-7 shrink-0 rounded-lg border-2 p-0 transition-transform hover:scale-105"
                  style={{
                    background: gradientCss(g),
                    borderColor: active ? "var(--ink)" : "transparent",
                    boxShadow: active ? "0 0 0 1px var(--paper) inset" : undefined,
                  }}
                />
              );
            })}
          </div>
        </Block>

        {error ? (
          <Alert role="alert" status="danger" className="mb-4">
            <Alert.Indicator />
            <Alert.Content>
              <Alert.Description>{error}</Alert.Description>
            </Alert.Content>
          </Alert>
        ) : null}

        <div className="flex items-center gap-3">
          <Button type="submit" isDisabled={!dirty || pending} isPending={pending}>
            {pending ? "Saving…" : "Save changes"}
          </Button>
          {saved ? <span className="text-[12.5px] text-muted">Saved.</span> : null}
        </div>
      </form>
    </div>
  );
}
