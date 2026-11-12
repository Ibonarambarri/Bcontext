/**
 * `/admin/orgs/:id` — the old address of one organization's admin page, kept
 * so bookmarks still land somewhere. It goes to the workspaces list rather
 * than a detail: the id named an organization, which no longer exists, and
 * no workspace shares it — guessing one would open the wrong page.
 */
import { permanentRedirect } from "next/navigation";

export default function LegacyAdminOrgPage() {
  permanentRedirect("/admin/workspaces");
}
