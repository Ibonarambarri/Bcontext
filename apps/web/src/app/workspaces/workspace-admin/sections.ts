/**
 * The sections of the workspace panel, named once, outside any client module.
 *
 * The hub's `page.tsx` is a Server Component that turns `?section=` into one
 * of these before the panel renders, and a function exported from a
 * `"use client"` file cannot be called on the server — so the list and its
 * parser live here, and `panel-ui.tsx`, the dialog and the workspace context
 * import them from this file. Must not break: every id here is a rail item in
 * `workspace-admin-modal.tsx` (`workspace-panel.test.ts` checks it).
 */

export const PANEL_SECTIONS = [
  "general",
  "members",
  "invitations",
  "usage",
  "business",
  "record-types",
  "ingest-keys",
] as const;

export type PanelSection = (typeof PANEL_SECTIONS)[number];

/** `?section=` as a section, or null for anything else. */
export function parsePanelSection(raw: string | null | undefined): PanelSection | null {
  return (PANEL_SECTIONS as readonly string[]).includes(raw ?? "")
    ? (raw as PanelSection)
    : null;
}
