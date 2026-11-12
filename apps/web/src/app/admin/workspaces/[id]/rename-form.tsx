"use client";

/**
 * Renaming a workspace from the instance admin's detail page
 * (`/admin/workspaces/[id]/page.tsx`), through `renameWorkspaceAction`.
 *
 * Only the name: the slug is the address people and agents have written
 * down, and the API freezes it at creation, so offering it here would be
 * offering a field that can only fail.
 *
 * The caller keys this form on the current name. When the rename lands, the
 * server action re-renders the page with the new name and the form remounts
 * from it; without the key, React's reset of a submitted form would put the
 * old name back in the box and the next press would rename it back.
 */

import { useActionState, useState } from "react";
import { Alert, Button, Input, Label, TextField } from "@heroui/react";
import { WORKSPACE_NAME_MAX } from "@bcontext-dev/contract/workspaces";
import { renameWorkspaceAction, type RenameFormState } from "../actions";

export function RenameForm({
  workspaceId,
  name,
}: {
  workspaceId: string;
  name: string;
}) {
  const [state, action, pending] = useActionState<RenameFormState, FormData>(
    renameWorkspaceAction,
    {},
  );
  const [value, setValue] = useState(name);
  // Pressing Rename on the name it already has is a write that changes
  // nothing, so the button waits until there is something to say.
  const unchanged = value.trim() === name || value.trim() === "";

  return (
    <div>
      <form action={action} className="flex flex-wrap items-end gap-3">
        <input type="hidden" name="workspace_id" value={workspaceId} />
        <TextField
          isRequired
          name="name"
          autoComplete="off"
          maxLength={WORKSPACE_NAME_MAX}
          value={value}
          onChange={setValue}
          className="min-w-56 flex-1"
        >
          <Label>Name</Label>
          <Input />
        </TextField>
        <Button
          type="submit"
          variant="secondary"
          isPending={pending}
          isDisabled={unchanged}
        >
          {pending ? "Renaming…" : "Rename"}
        </Button>
      </form>

      {state.error && (
        <Alert role="alert" status="danger" className="mt-3">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Description>{state.error}</Alert.Description>
          </Alert.Content>
        </Alert>
      )}
    </div>
  );
}
