/**
 * `/admin/orgs` — the old address of the admin's list, from before
 * organizations were folded into workspaces. It exists only so bookmarks and
 * links pasted into old conversations still land somewhere; nothing links
 * here any more. A permanent redirect, so browsers learn the new address.
 */
import { permanentRedirect } from "next/navigation";

export default function LegacyAdminOrgsPage() {
  permanentRedirect("/admin/workspaces");
}
