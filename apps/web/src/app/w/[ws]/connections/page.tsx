/**
 * Retired address: `/connections` and its `?tab=` split into the `agents` and
 * `webhooks` system views. Client-side redirect so the query and hash decide
 * the destination.
 */
import { LegacyAdminRedirect } from "@/components/legacy-admin-redirect";

export default async function LegacyConnectionsPage({ params }: { params: Promise<{ ws: string }> }) {
  const { ws } = await params;
  return <LegacyAdminRedirect workspace={{ slug: ws }} source="connections" />;
}
