/**
 * Retired address: `/browse` is what the workspace overview (`/w/<ws>`)
 * replaced. Client-side redirect so the query string and hash survive.
 */
import { LegacyBrowseRedirect } from "@/components/legacy-browse-redirect";

export default async function LegacyBrowsePage({ params }: { params: Promise<{ ws: string }> }) {
  const { ws } = await params;
  return <LegacyBrowseRedirect workspace={{ slug: ws }} />;
}
