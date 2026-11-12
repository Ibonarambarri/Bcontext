/**
 * `/workspaces` — the hub: every workspace the signed-in person belongs to.
 * The first page after login and where `/` lands.
 *
 * Server Component. Session from Supabase Auth (`@/web/session`), everything
 * else from `GET /api/workspaces?stats=1` through `@/web/api-client`; the view
 * models built here are what `workspaces-view.tsx` renders on the client. Not
 * under `/w/…`, so the workspace shell and its providers are absent — the hub
 * carries its own top bar and toasts.
 */
import { redirect } from "next/navigation";
import { isSupabaseConfigured } from "@bcontext-dev/contract/env";
import type { Route } from "next";
import { apiJson } from "@/web/api-client";
import { whoami } from "@/web/me";
import { getSession } from "@/web/session";
import type {
  WorkspaceCard,
  WorkspacesResponse,
} from "@bcontext-dev/contract/workspaces";
import { listTemplates } from "@bcontext-dev/contract/templates/workspaces";
import { WorkspacesView, type WorkspaceVM } from "./workspaces-view";
import { parsePanelSection } from "./workspace-admin/sections";

export const metadata = {
  title: "Workspaces — Bcontext",
};

interface Props {
  searchParams: Promise<{ ws?: string; section?: string }>;
}

/* Deterministic per slug: the same workspace gets the same hue and glyph
   on every render, with no stored preference needed. */
function hash(str: string): number {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) | 0;
  return Math.abs(h);
}
function hueFor(slug: string): number {
  const hues = [145, 250, 80, 30, 320, 60, 200, 0];
  return hues[hash(slug) % hues.length] ?? 145;
}
function glyphFor(name: string): string {
  return (name?.[0] ?? "·").toUpperCase();
}

function toVM(w: WorkspaceCard): WorkspaceVM {
  const meta = w.metadata ?? {};
  const customHue = typeof meta.accent_hue === "number" ? meta.accent_hue : null;
  return {
    id: w.id,
    slug: w.slug,
    name: w.name,
    glyph: glyphFor(w.name),
    description: w.description ?? null,
    role: w.role,
    memberCount: w.member_count,
    taskCount: w.open_task_count,
    nodeCount: w.node_count,
    accent: customHue ?? hueFor(w.slug),
    accentCustom: customHue !== null,
    metadata: meta,
    createdAt: w.created_at,
    lastActivity: w.last_activity_at,
    githubRepo: w.github_repo ?? null,
  };
}

export default async function WorkspacesIndexPage({ searchParams }: Props) {
  const sp = await searchParams;

  // Supabase off: the API answers from the demo store and there is no one to
  // sign in as, so the hub renders without a session.
  const demoMode = !isSupabaseConfigured();
  if (!demoMode) {
    const { data: auth } = await (await getSession()).auth.getUser();
    if (!auth.user) redirect("/login?next=/workspaces");
  }

  const { workspaces: cards, can_create_workspace: canCreate } =
    await apiJson<WorkspacesResponse>("/api/workspaces?stats=1");

  // Somebody with an account and no workspace: if they may create one,
  // `/start` asks for its name (this is also where the confirmation email
  // lands them); otherwise the hub's empty state says who can invite them.
  // Asked of `/api/me` rather than read off the hub's own answer so `/start`
  // and this page decide from the same source and can never bounce a person
  // between them. Only asked when there is nothing to show, so the common
  // path costs no extra request.
  if (!demoMode && cards.length === 0) {
    const me = await whoami();
    if (me?.can_create_workspace) redirect("/start" as Route);
  }

  const workspaces = cards.map(toVM);
  // What the create dialog offers as a starting point. Summarised here so the
  // template bodies (nodes, tags) never travel to the browser.
  const templates = listTemplates().map((t) => ({
    id: t.id,
    name: t.name,
    description: t.description,
    node_count: t.nodes.length,
  }));
  // The workspace panel is URL-driven: `?ws=<slug>` opens it for that
  // workspace, and `&section=` picks the part it opens on.
  const panelWs = sp.ws ? findWorkspace(workspaces, sp.ws) : null;

  return (
    <WorkspacesView
      workspaces={workspaces}
      canCreate={canCreate}
      panelWs={panelWs}
      panelSection={parsePanelSection(sp.section)}
      templates={templates}
    />
  );
}

/**
 * `?ws=` as a slug. A two-part value (`a~b`, from a link written before
 * workspaces stood alone) is matched by its workspace half, which is what
 * the slug was in nearly every case; when it is not, the panel simply does
 * not open and the hub is shown as it is.
 */
function findWorkspace(workspaces: WorkspaceVM[], raw: string): WorkspaceVM | null {
  const value = raw.trim().toLowerCase();
  const slug = value.includes("~") ? (value.split("~")[1] ?? "") : value;
  return workspaces.find((w) => w.slug === slug) ?? null;
}
