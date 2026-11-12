"use server";

/**
 * The two server actions behind `/start`: sign up (account + first workspace
 * in one form) and create a workspace for somebody already signed in.
 *
 * They are actions rather than `fetch` from the browser because the API's
 * same-origin guard and rate limit key on the request, and `apiJson`
 * forwards the person's own origin and cookies. Signing in after an account
 * that needs no confirmation goes through Supabase Auth here
 * (`getSession`), which writes the session cookie into this action's jar —
 * the jar `apiJson` reads, so the `POST /api/workspaces` right after it
 * already travels as the new person.
 *
 * Both carry the business model the form asked for (`business_model`,
 * product when absent or unknown) to `POST /api/workspaces`, which sets it
 * and applies its template — the same choice the new-workspace dialog
 * offers, so a first workspace is not always a product one.
 *
 * Must not break: `redirect()` throws, so it is never called inside a
 * `try`; and an account is never left half-made without telling the person
 * where to continue (`/start` picks up a signed-in person with no
 * workspace).
 */
import { redirect } from "next/navigation";
import type { Route } from "next";
import { ApiError, apiJson } from "@/web/api-client";
import { getSession } from "@/web/session";
import { workspacePath } from "@/web/workspace-url";
import { MIN_PASSWORD_LENGTH, type SignupResult } from "@bcontext-dev/contract/me";
import type { BusinessModel } from "@bcontext-dev/contract/business/record-types";
import { businessModelFrom } from "./business-model";
import {
  WORKSPACE_NAME_MAX,
  type CreateWorkspaceBody,
  type CreateWorkspaceResult,
} from "@bcontext-dev/contract/workspaces";

export interface SignupState {
  error?: string;
  /** The account waits for the confirmation link sent to this address. */
  sent?: { email: string; workspace: string; business_model: BusinessModel };
}

export interface WorkspaceState {
  error?: string;
}

function message(err: unknown, fallback: string): string {
  if (err instanceof ApiError) {
    const body = err.body as { message?: string; error?: string } | null;
    return body?.message ?? body?.error ?? fallback;
  }
  return fallback;
}

function workspaceName(formData: FormData): { name: string; error?: string } {
  const name = String(formData.get("workspace_name") ?? "").trim();
  if (!name) return { name, error: "What's the workspace called?" };
  if (name.length > WORKSPACE_NAME_MAX) {
    return { name, error: `Keep the name under ${WORKSPACE_NAME_MAX} characters.` };
  }
  return { name };
}

/** Create the workspace as the signed-in person; its path, or an error. */
async function createWorkspace(name: string, model: BusinessModel): Promise<{ path?: string; error?: string }> {
  try {
    // product is the API's default; leaving it out keeps the body what it was.
    const body: CreateWorkspaceBody = model === "product" ? { name } : { name, business_model: model };
    const { workspace } = await apiJson<CreateWorkspaceResult>("/api/workspaces", {
      method: "POST",
      body: JSON.stringify(body),
    });
    return { path: workspacePath(workspace.slug) };
  } catch (err) {
    return { error: message(err, "We couldn't create the workspace. Try again.") };
  }
}

/** Account and workspace in one go — or, when the address needs confirming, the account now and the workspace after the link. */
export async function signupAction(
  _prev: SignupState,
  formData: FormData,
): Promise<SignupState> {
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  const password = String(formData.get("password") ?? "");
  const confirm = String(formData.get("confirm") ?? "");
  const firstName = String(formData.get("first_name") ?? "").trim();
  const lastName = String(formData.get("last_name") ?? "").trim();
  const ws = workspaceName(formData);
  const model = businessModelFrom(formData);

  if (!firstName) return { error: "Tell us your name." };
  if (!email.includes("@")) return { error: "Enter a valid email address." };
  if (password.length < MIN_PASSWORD_LENGTH) {
    return { error: `Use at least ${MIN_PASSWORD_LENGTH} characters.` };
  }
  // Checked here and not by the API: the API never sees the second field,
  // and a typo in a password nobody can read back locks the person out of
  // the account they just made.
  if (password !== confirm) return { error: "The two passwords don't match." };
  if (ws.error) return { error: ws.error };

  let result: SignupResult;
  try {
    result = await apiJson<SignupResult>("/api/signup", {
      method: "POST",
      body: JSON.stringify({
        email,
        password,
        first_name: firstName,
        last_name: lastName || undefined,
      }),
    });
  } catch (err) {
    return { error: message(err, "We couldn't create the account. Try again.") };
  }

  if (result.confirmation === "email_sent") {
    return { sent: { email: result.email, workspace: ws.name, business_model: model } };
  }

  // No email transport on this instance: the account is already confirmed,
  // so sign in and create the workspace now.
  const { error: signInError } = await (await getSession()).auth.signInWithPassword({
    email,
    password,
  });
  if (signInError) redirect("/login?next=/start" as Route);

  const created = await createWorkspace(ws.name, model);
  if (!created.path) {
    // Signed in, workspace missing: `/start` asks for it again.
    redirect(`/start?error=${encodeURIComponent(created.error ?? "")}` as Route);
  }
  redirect(created.path as Route);
}

/** A signed-in person with no workspace names one. */
export async function createWorkspaceAction(
  _prev: WorkspaceState,
  formData: FormData,
): Promise<WorkspaceState> {
  const ws = workspaceName(formData);
  if (ws.error) return { error: ws.error };
  const created = await createWorkspace(ws.name, businessModelFrom(formData));
  if (!created.path) return { error: created.error };
  redirect(created.path as Route);
}
