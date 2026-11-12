"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { isSupabaseConfigured } from "@bcontext-dev/contract/env";
import { WORKSPACE_NAME_MAX } from "@bcontext-dev/contract/workspaces";
import { apiJson, ApiError } from "@/web/api-client";
import type {
  AdminInvite,
  AdminWorkspacePatch,
  CreateAdminWorkspaceResult,
  SendInviteEmailResult,
} from "@bcontext-dev/contract/admin-workspaces";

/**
 * The panel's writes. Creating a workspace or an invitation produces a link
 * and nothing else; `sendInviteEmailAction` is the only one that puts a
 * message in someone's inbox, and it exists as its own action so it can
 * never happen as a side effect of creating something.
 */
async function call<T>(path: string, init: Parameters<typeof apiJson>[1]): Promise<T> {
  if (!isSupabaseConfigured()) {
    throw new Error("Authentication is not configured.");
  }
  try {
    return await apiJson<T>(path, init);
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) {
      redirect("/login?next=/admin/workspaces");
    }
    throw err instanceof ApiError ? new Error(err.message) : err;
  }
}

/** Every write about one workspace goes through the same address. */
const workspacePath = (id: string) =>
  `/api/admin/workspaces/${encodeURIComponent(id)}`;

export interface WorkspaceFormState {
  error?: string;
  created?: CreateAdminWorkspaceResult;
}

export async function createWorkspaceAction(
  _prev: WorkspaceFormState,
  formData: FormData,
): Promise<WorkspaceFormState> {
  const name = String(formData.get("name") ?? "").trim();
  const slug = String(formData.get("slug") ?? "").trim();
  const owner_email = String(formData.get("owner_email") ?? "").trim();
  const role = String(formData.get("role") ?? "owner");
  if (!name) return { error: "The workspace needs a name." };
  if (!owner_email) return { error: "Who owns it? Enter their email." };
  try {
    const created = await call<CreateAdminWorkspaceResult>("/api/admin/workspaces", {
      method: "POST",
      json: { name, slug: slug || undefined, owner_email, role },
    });
    revalidatePath("/admin/workspaces");
    return { created };
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Couldn't create it." };
  }
}

export interface RenameFormState {
  error?: string;
}

/**
 * The one property of a workspace the panel edits. The slug is not offered:
 * it is the address people and agents have written down, and the API freezes
 * it at creation for that reason.
 */
export async function renameWorkspaceAction(
  _prev: RenameFormState,
  formData: FormData,
): Promise<RenameFormState> {
  const workspaceId = String(formData.get("workspace_id") ?? "");
  const name = String(formData.get("name") ?? "").trim();
  if (!workspaceId) return { error: "Missing workspace." };
  if (!name) return { error: "The workspace needs a name." };
  if (name.length > WORKSPACE_NAME_MAX) {
    return { error: `Keep it under ${WORKSPACE_NAME_MAX} characters.` };
  }
  try {
    const patch: AdminWorkspacePatch = { name };
    await call<unknown>(workspacePath(workspaceId), {
      method: "PATCH",
      json: patch,
    });
    // The name is printed on the list row and in the detail's crumb, so both
    // are re-read rather than leaving one of them on the old name.
    revalidatePath("/admin/workspaces");
    revalidatePath(`/admin/workspaces/${workspaceId}`);
    return {};
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Couldn't rename it." };
  }
}

export interface InviteFormState {
  error?: string;
  invite?: AdminInvite;
}

export async function createInviteAction(
  _prev: InviteFormState,
  formData: FormData,
): Promise<InviteFormState> {
  const workspaceId = String(formData.get("workspace_id") ?? "");
  const email = String(formData.get("email") ?? "").trim();
  const role = String(formData.get("role") ?? "admin");
  if (!workspaceId) return { error: "Missing workspace." };
  if (!email) return { error: "Enter an email address." };
  try {
    const { invite } = await call<{ invite: AdminInvite }>(
      `${workspacePath(workspaceId)}/invites`,
      { method: "POST", json: { email, role } },
    );
    revalidatePath(`/admin/workspaces/${workspaceId}`);
    return { invite };
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Couldn't invite them." };
  }
}

export interface SendEmailState {
  error?: string;
  sent?: SendInviteEmailResult;
}

/** The one irreversible action in the panel, and it takes a click of its own. */
export async function sendInviteEmailAction(
  _prev: SendEmailState,
  formData: FormData,
): Promise<SendEmailState> {
  const inviteId = String(formData.get("invite_id") ?? "");
  const workspaceId = String(formData.get("workspace_id") ?? "");
  if (!inviteId) return { error: "Missing invitation." };
  try {
    const sent = await call<SendInviteEmailResult>(
      `/api/admin/invites/${encodeURIComponent(inviteId)}/email`,
      { method: "POST" },
    );
    if (workspaceId) revalidatePath(`/admin/workspaces/${workspaceId}`);
    return { sent };
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Couldn't send it." };
  }
}

export async function revokeInviteAction(formData: FormData) {
  const workspaceId = String(formData.get("workspace_id") ?? "");
  const inviteId = String(formData.get("invite_id") ?? "");
  if (!workspaceId || !inviteId) throw new Error("Missing invitation.");
  await call(
    `${workspacePath(workspaceId)}/invites/${encodeURIComponent(inviteId)}`,
    { method: "DELETE" },
  );
  revalidatePath(`/admin/workspaces/${workspaceId}`);
}
