import { describe, expect, it } from "vitest";
import { apiErrorMessage } from "./new-workspace-modal";

/** What to say when the API refuses the workspace. */
describe("apiErrorMessage", () => {
  it("prefers the message the route wrote", () => {
    expect(
      apiErrorMessage(
        { error: "workspace_creation_restricted", message: "Only the instance administrators create workspaces here." },
        403,
      ),
    ).toBe("Only the instance administrators create workspaces here.");
  });

  it("reads a flattened validation error rather than showing the status", () => {
    expect(
      apiErrorMessage(
        { error: { formErrors: [], fieldErrors: { name: ["Required"] } } },
        400,
      ),
    ).toBe("name: Required");
  });

  it("falls back to the code when that is all there is", () => {
    expect(apiErrorMessage({ error: "workspace_creation_restricted" }, 403)).toBe(
      "workspace_creation_restricted",
    );
  });

  it("says something a person can read when the body says nothing", () => {
    expect(apiErrorMessage(null, 500)).toContain("HTTP 500");
    expect(apiErrorMessage("<html>", 502)).toContain("HTTP 502");
  });
});
