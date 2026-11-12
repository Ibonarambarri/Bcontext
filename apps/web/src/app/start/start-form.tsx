"use client";

/**
 * The two forms of `/start`, in the auth pages' paper language.
 *
 * `SignupForm` takes the account and the workspace's name together, so a
 * person who needs no email confirmation lands in their first workspace in
 * one submit. When the instance does send a confirmation, the workspace is
 * created after the link: the name typed here is kept in this browser
 * (`localStorage`, a convenience only) and `WorkspaceForm` offers it back.
 */
import { useActionState, useEffect, useState } from "react";
import { MIN_PASSWORD_LENGTH, MAX_NAME_LENGTH } from "@bcontext-dev/contract/me";
import { WORKSPACE_NAME_MAX } from "@bcontext-dev/contract/workspaces";
import {
  createWorkspaceAction,
  signupAction,
  type SignupState,
  type WorkspaceState,
} from "./actions";

/** Where the workspace's name waits while the person confirms their email. */
const PENDING_WORKSPACE_KEY = "bcontext.start.workspace";

function remember(name: string) {
  try {
    localStorage.setItem(PENDING_WORKSPACE_KEY, name);
  } catch {
    /* storage unavailable: the person types the name again */
  }
}

function recall(): string {
  try {
    return localStorage.getItem(PENDING_WORKSPACE_KEY) ?? "";
  } catch {
    return "";
  }
}

function forget() {
  try {
    localStorage.removeItem(PENDING_WORKSPACE_KEY);
  } catch {
    /* nothing to clean */
  }
}

export function SignupForm({ prefillEmail }: { prefillEmail?: string }) {
  const [state, action, pending] = useActionState<SignupState, FormData>(signupAction, {});

  useEffect(() => {
    if (state.sent) remember(state.sent.workspace);
  }, [state.sent]);

  if (state.sent) return <CheckInbox email={state.sent.email} />;

  return (
    <div>
      <div className="pa-kicker">Start</div>
      <h1 className="pa-title">
        Create your <em>workspace.</em>
      </h1>
      <p className="pa-sub">Your account and your first workspace, in one step.</p>

      <form action={action} className="pa-form">
        <div className="pa-row-2">
          <div className="pa-field">
            <label className="pa-label" htmlFor="first_name">
              First name
            </label>
            <input
              id="first_name"
              name="first_name"
              className="pa-input"
              autoComplete="given-name"
              maxLength={MAX_NAME_LENGTH}
              placeholder="Ana"
              required
              disabled={pending}
            />
          </div>
          <div className="pa-field">
            <label className="pa-label" htmlFor="last_name">
              Last name
              <span className="pa-optional"> optional</span>
            </label>
            <input
              id="last_name"
              name="last_name"
              className="pa-input"
              autoComplete="family-name"
              maxLength={MAX_NAME_LENGTH}
              placeholder="Ruiz"
              disabled={pending}
            />
          </div>
        </div>

        <div className="pa-field">
          <label className="pa-label" htmlFor="email">
            Email
          </label>
          <input
            id="email"
            name="email"
            type="email"
            className="pa-input"
            autoComplete="email"
            inputMode="email"
            placeholder="you@company.com"
            defaultValue={prefillEmail}
            required
            disabled={pending}
          />
        </div>

        <div className="pa-row-2">
          <div className="pa-field">
            <label className="pa-label" htmlFor="password">
              Password
            </label>
            <input
              id="password"
              name="password"
              type="password"
              className="pa-input"
              autoComplete="new-password"
              minLength={MIN_PASSWORD_LENGTH}
              placeholder="••••••••"
              required
              disabled={pending}
            />
          </div>
          <div className="pa-field">
            <label className="pa-label" htmlFor="confirm">
              Confirm password
            </label>
            <input
              id="confirm"
              name="confirm"
              type="password"
              className="pa-input"
              autoComplete="new-password"
              minLength={MIN_PASSWORD_LENGTH}
              placeholder="••••••••"
              required
              disabled={pending}
            />
          </div>
        </div>

        <WorkspaceNameField pending={pending} />

        {state.error ? (
          <p role="alert" className="pa-alert pa-alert-danger">
            {state.error}
          </p>
        ) : null}

        <button type="submit" className="pa-submit" disabled={pending}>
          {pending ? "Creating…" : "Create account and workspace"}
        </button>

        <p className="pa-foot">
          Already have an account?{" "}
          <a className="pa-link" href="/login">
            Sign in
          </a>
        </p>
      </form>
    </div>
  );
}

export function WorkspaceForm({ initialError }: { initialError?: string }) {
  const [state, action, pending] = useActionState<WorkspaceState, FormData>(
    createWorkspaceAction,
    { error: initialError },
  );
  const [name, setName] = useState("");

  // Read after mount: the server render has no storage, and a value that
  // differs between the two renders is a hydration mismatch.
  useEffect(() => {
    setName(recall());
  }, []);

  return (
    <div>
      <div className="pa-kicker">One last thing</div>
      <h1 className="pa-title">
        Name your <em>workspace.</em>
      </h1>
      <p className="pa-sub">
        You&apos;ll be its owner, free to invite people and connect agents.
      </p>

      <form action={action} onSubmit={forget} className="pa-form">
        <WorkspaceNameField pending={pending} value={name} onChange={setName} />

        {state.error ? (
          <p role="alert" className="pa-alert pa-alert-danger">
            {state.error}
          </p>
        ) : null}

        <button type="submit" className="pa-submit" disabled={pending}>
          {pending ? "Creating…" : "Create workspace"}
        </button>
      </form>
    </div>
  );
}

function WorkspaceNameField({
  pending,
  value,
  onChange,
}: {
  pending: boolean;
  value?: string;
  onChange?: (value: string) => void;
}) {
  return (
    <div className="pa-field">
      <label className="pa-label" htmlFor="workspace_name">
        Workspace name
      </label>
      <input
        id="workspace_name"
        name="workspace_name"
        className="pa-input"
        // A workspace is named for the work, not the company: the browser's
        // saved company name would be a wrong guess more often than a help.
        autoComplete="off"
        maxLength={WORKSPACE_NAME_MAX}
        placeholder="Acme"
        required
        disabled={pending}
        {...(onChange ? { value, onChange: (e) => onChange(e.target.value) } : {})}
      />
    </div>
  );
}

function CheckInbox({ email }: { email: string }) {
  return (
    <div>
      <div className="pa-kicker">Account created</div>
      <h1 className="pa-title">
        Now confirm your <em>email.</em>
      </h1>
      <p className="pa-sub">
        We sent a link to <strong>{email}</strong>. Open it and you&apos;ll
        create your workspace right after.
      </p>
      <p className="pa-alert">Nothing in your inbox? Look in your spam folder.</p>
      <a className="pa-alt-link" href="/login">
        Go to sign in
      </a>
    </div>
  );
}
