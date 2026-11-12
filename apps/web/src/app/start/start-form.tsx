"use client";

/**
 * The two forms of `/start`, in the auth pages' paper language.
 *
 * `SignupForm` takes the account and the workspace's name together, so a
 * person who needs no email confirmation lands in their first workspace in
 * one submit. When the instance does send a confirmation, the workspace is
 * created after the link: the name typed here is kept in this browser
 * (`localStorage`, a convenience only) and `WorkspaceForm` offers it back.
 *
 * Both ask what kind of business the workspace is (`BusinessModelField`:
 * B2B, B2C, Marketplace, or product — preselected), the same four the
 * new-workspace dialog offers, so a first workspace gets its template too.
 * Native radios, not the HeroUI picker: these are plain server-action forms.
 */
import { useActionState, useEffect, useState } from "react";
import { MIN_PASSWORD_LENGTH, MAX_NAME_LENGTH } from "@bcontext-dev/contract/me";
import { WORKSPACE_NAME_MAX } from "@bcontext-dev/contract/workspaces";
import type { BusinessModel } from "@bcontext-dev/contract/business/record-types";
import { BUSINESS_MODEL_OPTIONS } from "@/lib/business/models";
import { START_DEFAULT_MODEL, parseStoredModel } from "./business-model";
import {
  createWorkspaceAction,
  signupAction,
  type SignupState,
  type WorkspaceState,
} from "./actions";

/** Where the workspace's name and model wait while the person confirms their email. */
const PENDING_WORKSPACE_KEY = "bcontext.start.workspace";
const PENDING_MODEL_KEY = "bcontext.start.business_model";

function remember(name: string, model: BusinessModel) {
  try {
    localStorage.setItem(PENDING_WORKSPACE_KEY, name);
    localStorage.setItem(PENDING_MODEL_KEY, model);
  } catch {
    /* storage unavailable: the person answers again */
  }
}

function recall(): { name: string; model: BusinessModel } {
  try {
    return {
      name: localStorage.getItem(PENDING_WORKSPACE_KEY) ?? "",
      model: parseStoredModel(localStorage.getItem(PENDING_MODEL_KEY)),
    };
  } catch {
    return { name: "", model: START_DEFAULT_MODEL };
  }
}

function forget() {
  try {
    localStorage.removeItem(PENDING_WORKSPACE_KEY);
    localStorage.removeItem(PENDING_MODEL_KEY);
  } catch {
    /* nothing to clean */
  }
}

export function SignupForm({ prefillEmail }: { prefillEmail?: string }) {
  const [state, action, pending] = useActionState<SignupState, FormData>(signupAction, {});

  useEffect(() => {
    if (state.sent) remember(state.sent.workspace, state.sent.business_model);
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
        <BusinessModelField pending={pending} />

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
  const [model, setModel] = useState<BusinessModel>(START_DEFAULT_MODEL);

  // Read after mount: the server render has no storage, and a value that
  // differs between the two renders is a hydration mismatch.
  useEffect(() => {
    const pendingChoice = recall();
    setName(pendingChoice.name);
    setModel(pendingChoice.model);
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
        <BusinessModelField pending={pending} value={model} onChange={setModel} />

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

/**
 * What kind of business the workspace is, as `business_model` in the form.
 * Uncontrolled in the sign-up form (product checked by default), controlled
 * in the workspace form so a choice remembered across the email link shows.
 */
function BusinessModelField({
  pending,
  value,
  onChange,
}: {
  pending: boolean;
  value?: BusinessModel;
  onChange?: (value: BusinessModel) => void;
}) {
  return (
    <fieldset className="pa-field pa-choices" disabled={pending}>
      <legend className="pa-label">What kind of business is it?</legend>
      {BUSINESS_MODEL_OPTIONS.map((option) => (
        <label key={option.id} className="pa-choice">
          <input
            type="radio"
            name="business_model"
            value={option.id}
            {...(onChange
              ? { checked: value === option.id, onChange: () => onChange(option.id) }
              : { defaultChecked: option.id === START_DEFAULT_MODEL })}
          />
          <span>
            <span className="pa-choice-title">{option.label}</span>
            <span className="pa-choice-line">{option.line}</span>
          </span>
        </label>
      ))}
    </fieldset>
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
