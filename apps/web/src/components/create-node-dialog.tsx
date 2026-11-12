"use client";

/**
 * Centered "create node" dialog, mounted by `create-node-dialog-host.tsx`
 * (which owns the `bcontext:new-node` event and the ⌘⇧K binding). HeroUI
 * `Modal` throughout; the tiles are the same outline-`Button` choice cards
 * `add-agent-modal.tsx` uses, so the two dialogs read as one family.
 *
 * Two-step flow:
 *
 *   Step 1 — Kind picker (`KIND_OPTIONS`: doc, task, meeting, decision, adr,
 *            bug, data, credential, goal; never `folder`, a test guards it).
 *            Default kind is `doc`. Each tile shows icon + label + a short
 *            description so the dialog teaches what each kind is for.
 *
 *   Step 2 — Kind-specific form, plus "Connect to" (`connect-picker.tsx`):
 *     one search box that sets the semantic parent (one node) and the tags
 *     (several) the node is created with — the whole connection surface,
 *     since the web has no edge endpoint.
 *     • Most kinds: a title. Submit creates the node through the workspace
 *       context (`createNode`, optimistic) and navigates to it.
 *     • Credential: also type + environment, so the node is created already
 *       shaped (`CredentialShape`).
 *     • Meeting: an optional title and the pasted transcript; the node is
 *       created, then `POST /api/meetings/attach-transcript/:id` attaches
 *       the transcript and starts the refine job.
 *
 * Workspace tags are read once per open (`GET /api/tags`, the same call
 * `tag-picker.tsx` makes); the workspace context does not carry them.
 */
import {
  CREDENTIAL_ENVIRONMENTS,
  CREDENTIAL_ENVIRONMENT_LABELS,
  CREDENTIAL_TYPES,
  credentialTypeDef,
  emptyCredential,
  writeCredential,
  type CredentialEnvironment,
  type CredentialTypeId,
} from "@bcontext-dev/contract/credentials";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import type { Route } from "next";
import {
  Bug,
  CheckSquare,
  ClipboardPaste,
  FileText,
  GitBranch,
  KeyRound,
  Loader2,
  Mic,
  Sparkles,
  Table2,
  Target,
} from "lucide-react";
import {
  Button,
  Description,
  Input,
  Label,
  ListBox,
  Modal,
  Select,
  TextArea,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
} from "@heroui/react";
import { cn } from "@bcontext-dev/contract/utils";
import { useToast, useWorkspace } from "@/components/workspace-context";
import type { NodeKind, WorkspaceTag } from "@bcontext-dev/contract/types";
import { workspacePath, workspaceApiRef, type WorkspaceAddress } from "@/web/workspace-url";
import { ConnectPicker, type ConnectValue } from "./connect-picker";

type Step = "kind" | "form" | "meeting-paste";

interface KindOption {
  kind: NodeKind;
  label: string;
  description: string;
  Icon: typeof FileText;
}

export const KIND_OPTIONS: KindOption[] = [
  {
    kind: "doc",
    label: "Doc",
    description: "Free-form Markdown — specs, notes, write-ups.",
    Icon: FileText,
  },
  {
    kind: "task",
    label: "Task",
    description: "Actionable work item with status + priority.",
    Icon: CheckSquare,
  },
  {
    kind: "meeting",
    label: "Meeting",
    description: "Paste a transcript; it is refined into notes.",
    Icon: Mic,
  },
  {
    kind: "decision",
    label: "Decision",
    description: "Recorded choice with rationale and alternatives.",
    Icon: GitBranch,
  },
  {
    kind: "adr",
    label: "ADR",
    description: "Architecture Decision Record. Long-lived.",
    Icon: GitBranch,
  },
  {
    kind: "bug",
    label: "Bug",
    description: "Defect with repro steps and impact.",
    Icon: Bug,
  },
  {
    kind: "data",
    label: "Data",
    description: "A CSV table — paste rows, browse them as a grid.",
    Icon: Table2,
  },
  {
    kind: "credential",
    label: "Credential",
    description: "One key, login or token — typed, per environment.",
    Icon: KeyRound,
  },
  {
    kind: "goal",
    label: "Goal",
    description: "An objective with key results and a horizon — company or project.",
    Icon: Target,
  },
];

const EMPTY_CONNECT: ConnectValue = { parentId: null, tagIds: [] };

/** Workspace tags for the picker, loaded once per open; empty until they arrive or if the read fails. */
function useWorkspaceTags(workspace: WorkspaceAddress, open: boolean): WorkspaceTag[] {
  const [tags, setTags] = useState<WorkspaceTag[]>([]);
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    fetch(`/api/tags?workspace=${encodeURIComponent(workspaceApiRef(workspace))}`, { cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) throw new Error("could not load tags");
        return response.json() as Promise<{ tags: WorkspaceTag[] }>;
      })
      .then((body) => {
        if (!cancelled) setTags(body.tags ?? []);
      })
      .catch(() => {
        // The picker simply offers no tags.
      });
    return () => {
      cancelled = true;
    };
  }, [workspace, open]);
  return tags;
}

export function CreateNodeDialog({
  open,
  onClose,
  workspace,
  defaultKind = "doc",
}: {
  open: boolean;
  onClose: () => void;
  workspace: WorkspaceAddress;
  defaultKind?: NodeKind;
}) {
  const router = useRouter();
  const toast = useToast();
  const { createNode, nodes } = useWorkspace();
  const tags = useWorkspaceTags(workspace, open);

  const [step, setStep] = useState<Step>("kind");
  const [kind, setKind] = useState<NodeKind>(defaultKind);
  const [credentialType, setCredentialType] = useState<CredentialTypeId>("api_key");
  const [credentialEnv, setCredentialEnv] = useState<CredentialEnvironment | "">("");
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [connect, setConnect] = useState<ConnectValue>(EMPTY_CONNECT);

  // Meeting-specific
  const [transcript, setTranscript] = useState("");

  // Reset on close
  useEffect(() => {
    if (!open) {
      setStep("kind");
      setKind(defaultKind);
      setTitle("");
      setBusy(false);
      setConnect(EMPTY_CONNECT);
      setTranscript("");
      setCredentialType("api_key");
      setCredentialEnv("");
    }
  }, [open, defaultKind]);

  const advanceFromKind = useCallback(() => {
    if (kind === "meeting") setStep("meeting-paste");
    else setStep("form");
  }, [kind]);

  const connection = useMemo(
    () => ({ parent_id: connect.parentId, tag_ids: connect.tagIds.length ? connect.tagIds : undefined }),
    [connect],
  );

  const submitSimple = useCallback(async () => {
    const t = title.trim();
    if (!t) return;
    setBusy(true);
    try {
      // A credential is created already typed: the slots for its shape are
      // what the form just asked about, and an untyped credential would land
      // as `custom` — the edge case, not the default.
      const data =
        kind === "credential"
          ? writeCredential(emptyCredential(credentialType, credentialEnv || null))
          : undefined;
      const node = await createNode({ title: t, kind, ...connection, data });
      if (node) {
        onClose();
        router.push(workspacePath(workspace, `n/${node.id}`) as Route);
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [title, kind, connection, credentialType, credentialEnv, createNode, onClose, router, workspace, toast]);

  const submitMeetingPaste = useCallback(async () => {
    const t = title.trim() || defaultMeetingTitle();
    const transcriptTrim = transcript.trim();
    if (transcriptTrim.length < 50) return;
    setBusy(true);
    try {
      const node = await createNode({ title: t, kind: "meeting", ...connection });
      if (!node) return;
      const res = await fetch(`/api/meetings/attach-transcript/${node.id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ transcript: transcriptTrim }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as {
          message?: string;
          error?: unknown;
        };
        const msg =
          typeof body.message === "string"
            ? body.message
            : typeof body.error === "string"
              ? body.error
              : `Attach failed (${res.status})`;
        toast.error(msg);
        return;
      }
      toast.info("Transcript attached — refining…");
      onClose();
      router.push(workspacePath(workspace, `n/${node.id}`) as Route);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [title, transcript, connection, createNode, onClose, router, workspace, toast]);

  if (!open) return null;

  const { heading, subtitle } = stepCopy(step, kind);
  const KindIcon = KIND_OPTIONS.find((option) => option.kind === kind)?.Icon ?? Sparkles;
  const picker = <ConnectPicker nodes={nodes} tags={tags} value={connect} onChange={setConnect} isDisabled={busy} />;

  return (
    <Modal.Backdrop
      isOpen
      isDismissable={!busy}
      onOpenChange={(next) => {
        if (!next && !busy) onClose();
      }}
    >
      {/* scroll="outside": the body must not clip the picker's results list,
          which hangs below the field; a long form scrolls the page instead. */}
      <Modal.Container placement="top" size="md" scroll="outside" className="pt-[8vh]">
        <Modal.Dialog aria-label={heading} className="sm:max-w-[640px]">
          <Modal.CloseTrigger />
          <Modal.Header className="gap-1">
            <Modal.Icon className="bg-default text-foreground">
              {step === "kind" ? <Sparkles className="size-4" /> : <KindIcon className="size-4" />}
            </Modal.Icon>
            <Modal.Heading>{heading}</Modal.Heading>
            <p className="text-[12.5px] leading-relaxed text-muted">{subtitle}</p>
          </Modal.Header>

          <Modal.Body className="flex flex-col gap-4">
            {step === "kind" ? <KindGrid value={kind} onChange={setKind} onContinue={advanceFromKind} /> : null}

            {step === "form" ? (
              <>
                <TitleField
                  label={`Title · ${kind}`}
                  value={title}
                  onChange={setTitle}
                  autoFocus
                  onSubmit={title.trim().length > 0 && !busy ? submitSimple : undefined}
                />
                {kind === "credential" ? (
                  <CredentialShape
                    type={credentialType}
                    environment={credentialEnv}
                    onTypeChange={setCredentialType}
                    onEnvironmentChange={setCredentialEnv}
                  />
                ) : null}
                {picker}
              </>
            ) : null}

            {step === "meeting-paste" ? (
              <>
                <TitleField label="Title" optional value={title} onChange={setTitle} />
                <TextField value={transcript} onChange={setTranscript} fullWidth>
                  <Label>Transcript</Label>
                  <TextArea
                    autoFocus
                    rows={9}
                    placeholder="**Alice · 00:00** — Hey team, welcome…"
                    className="mono text-[12.5px] leading-[1.55]"
                  />
                  <Description className="mono text-[11px]">
                    {transcript.trim().length} chars · minimum 50
                  </Description>
                </TextField>
                {picker}
              </>
            ) : null}
          </Modal.Body>

          <Modal.Footer>
            {step === "kind" ? (
              <Button variant="secondary" onPress={onClose}>
                Cancel
              </Button>
            ) : (
              <Button
                variant="secondary"
                isDisabled={busy}
                onPress={() => setStep("kind")}
              >
                Back
              </Button>
            )}
            <span className="flex-1" />
            {step === "kind" ? <Button onPress={advanceFromKind}>Continue</Button> : null}
            {step === "form" ? (
              <SubmitButton busy={busy} isDisabled={title.trim().length === 0} onPress={submitSimple}>
                Create
              </SubmitButton>
            ) : null}
            {step === "meeting-paste" ? (
              <SubmitButton
                busy={busy}
                isDisabled={transcript.trim().length < 50}
                icon={<ClipboardPaste size={12} />}
                onPress={submitMeetingPaste}
              >
                Create + attach
              </SubmitButton>
            ) : null}
          </Modal.Footer>
        </Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
  );
}

function defaultMeetingTitle(): string {
  const d = new Date();
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `Meeting · ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function stepCopy(step: Step, kind: NodeKind): { heading: string; subtitle: string } {
  switch (step) {
    case "kind":
      return { heading: "Create a new node", subtitle: "Pick a kind. You can change content later." };
    case "form":
      return { heading: `New ${KIND_OPTIONS.find((option) => option.kind === kind)?.label.toLowerCase() ?? "node"}`, subtitle: "Give it a title and, if you like, connect it." };
    case "meeting-paste":
      return { heading: "New meeting", subtitle: "Paste the transcript. Plain text or Markdown; speaker labels keep their format." };
  }
}

/* ─── Shared pieces ───────────────────────────────────────────────────── */

/** The title field every step shares; Enter submits when the step says it can. */
function TitleField({
  label,
  optional = false,
  value,
  onChange,
  autoFocus = false,
  onSubmit,
}: {
  label: string;
  optional?: boolean;
  value: string;
  onChange: (value: string) => void;
  autoFocus?: boolean;
  onSubmit?: () => void;
}) {
  return (
    <TextField value={value} onChange={onChange} fullWidth>
      <Label>
        {label}
        {optional ? <span className="ml-1 text-[var(--ink-mute)]">(optional)</span> : null}
      </Label>
      <Input
        autoFocus={autoFocus}
        placeholder={optional ? "Auto-named from date when blank" : "Untitled"}
        onKeyDown={(event) => {
          if (event.key === "Enter" && onSubmit) {
            event.preventDefault();
            onSubmit();
          }
        }}
      />
    </TextField>
  );
}

function SubmitButton({
  busy,
  isDisabled,
  icon,
  onPress,
  children,
}: {
  busy: boolean;
  isDisabled: boolean;
  icon?: ReactNode;
  onPress: () => void;
  children: ReactNode;
}) {
  return (
    <Button onPress={onPress} isDisabled={isDisabled || busy} className="gap-1.5">
      {busy ? <Loader2 size={12} className="animate-spin" /> : icon}
      {children}
    </Button>
  );
}

/**
 * A selectable tile — the outline Button with its content stacked, the
 * same shape as the choice cards in the Add agent dialog.
 */
function ChoiceTile({
  active = false,
  onPress,
  icon,
  title,
  description,
  className,
}: {
  active?: boolean;
  onPress: () => void;
  icon: ReactNode;
  title: string;
  description: string;
  className?: string;
}) {
  return (
    <Button
      variant="outline"
      aria-pressed={active}
      onPress={onPress}
      className={cn(
        "h-auto flex-col items-start gap-1.5 rounded-lg border p-3 text-left font-normal",
        active ? "border-[var(--ink)] bg-[var(--paper-2)]" : "border-[var(--line)]",
        className,
      )}
    >
      <span className="flex size-7 items-center justify-center rounded-md border border-[var(--line)] bg-[var(--paper)] text-[var(--ink)]">
        {icon}
      </span>
      <span className="text-[12.5px] font-medium">{title}</span>
      <span className="block whitespace-normal text-[11px] leading-relaxed text-[var(--ink-3)]">{description}</span>
    </Button>
  );
}

/* ─── Step 1: kind grid ───────────────────────────────────────────────── */

function KindGrid({
  value,
  onChange,
  onContinue,
}: {
  value: NodeKind;
  onChange: (kind: NodeKind) => void;
  onContinue: () => void;
}) {
  return (
    <div role="group" aria-label="Kind" className="grid grid-cols-2 gap-2 sm:grid-cols-3">
      {KIND_OPTIONS.map(({ kind, label, description, Icon }) => (
        <ChoiceTile
          key={kind}
          active={value === kind}
          // A second press on the chosen tile is a "yes, this one".
          onPress={() => (value === kind ? onContinue() : onChange(kind))}
          icon={<Icon size={14} />}
          title={label}
          description={description}
        />
      ))}
    </div>
  );
}

/* ─── Step 2 (credential): which credential is this ──────────────────── */

/**
 * A credential is created already typed and already placed. Both questions
 * are cheap to answer now and expensive to answer later: the type decides
 * which fields the node asks for, and the environment is what keeps the prod
 * key and the dev key from ending up in the same node — the one thing this
 * kind is not allowed to do.
 */
function CredentialShape({
  type,
  environment,
  onTypeChange,
  onEnvironmentChange,
}: {
  type: CredentialTypeId;
  environment: CredentialEnvironment | "";
  onTypeChange: (type: CredentialTypeId) => void;
  onEnvironmentChange: (environment: CredentialEnvironment | "") => void;
}) {
  return (
    <div className="flex flex-col gap-4">
      <Select
        value={type}
        onChange={(key) => {
          if (key != null && !Array.isArray(key)) onTypeChange(String(key) as CredentialTypeId);
        }}
        fullWidth
      >
        <Label>Type</Label>
        <Select.Trigger>
          <Select.Value />
          <Select.Indicator />
        </Select.Trigger>
        <Description>{credentialTypeDef(type).description}</Description>
        <Select.Popover>
          <ListBox>
            {CREDENTIAL_TYPES.map((option) => (
              <ListBox.Item key={option.id} id={option.id} textValue={option.label}>
                {option.label}
                <ListBox.ItemIndicator />
              </ListBox.Item>
            ))}
          </ListBox>
        </Select.Popover>
      </Select>
      <div className="flex flex-col gap-1.5">
        <Label>Environment</Label>
        <ToggleButtonGroup
          aria-label="Environment"
          size="sm"
          isDetached
          selectionMode="single"
          disallowEmptySelection
          selectedKeys={[environment || "none"]}
          onSelectionChange={(keys) => {
            const key = [...keys][0];
            onEnvironmentChange(key == null || key === "none" ? "" : (String(key) as CredentialEnvironment));
          }}
          className="flex-wrap"
        >
          <ToggleButton id="none" variant="ghost">
            Not set
          </ToggleButton>
          {CREDENTIAL_ENVIRONMENTS.map((option) => (
            <ToggleButton key={option} id={option} variant="ghost">
              {CREDENTIAL_ENVIRONMENT_LABELS[option]}
            </ToggleButton>
          ))}
        </ToggleButtonGroup>
        <Description>One node is one credential. The same service in dev and in prod is two nodes.</Description>
      </div>
    </div>
  );
}
