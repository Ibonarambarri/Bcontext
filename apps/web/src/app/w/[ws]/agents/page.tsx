/**
 * Retired address, kept so old links and bookmarks keep working: `/agents`
 * became the `agents` system view. The redirect runs client-side because the
 * old `?tab=` query decides which surface (agents or webhooks) it lands on,
 * and only the browser has the query and the hash.
 */
import { LegacyAdminRedirect } from "@/components/legacy-admin-redirect";

export const metadata = {
  title: "Agents — Bcontext",
};

export default async function AgentsPage({
  params,
}: {
  params: Promise<{ ws: string }>;
}) {
  const { ws } = await params;
  return <LegacyAdminRedirect workspace={{ slug: ws }} source="agents" />;
}
