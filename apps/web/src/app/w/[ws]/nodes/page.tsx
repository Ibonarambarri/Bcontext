/**
 * Retired address: `/nodes`, like `/browse`, now lands on the workspace
 * overview (`/w/<ws>`). Client-side redirect so the query survives.
 */
import { LegacyBrowseRedirect } from "@/components/legacy-browse-redirect";

export default async function LegacyNodesPage({ params }: { params: Promise<{ ws: string }> }) {
  const { ws } = await params;
  return <LegacyBrowseRedirect workspace={{ slug: ws }} />;
}
