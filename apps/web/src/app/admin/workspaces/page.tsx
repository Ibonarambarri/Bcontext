import { apiJson, ApiError } from "@/web/api-client";
import type {
  AdminWorkspaceStateFilter,
  AdminPage as ApiPage,
} from "@bcontext-dev/contract/admin-workspaces";
import type { AdminWorkspaceSummaryWithSpend } from "./ai-spend";
import { Alert } from "@heroui/react";
import { AdminPage } from "@/components/admin/admin-shell";
import { CreateWorkspaceDrawer } from "./create-workspace-form";
import { WorkspacesList } from "./workspaces-list";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Admin · Workspaces — Bcontext",
};

/** The API's own page size, so an answer that never arrived is still drawn
 *  with the shape of one. */
const PAGE_SIZE = 50;

interface PageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

function one(value: string | string[] | undefined): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Who is inside, one row per workspace. An operator can also create a
 * workspace here, with the invitation for its first owner, and decide how
 * that invitation travels.
 *
 * Search and state are query parameters and reach the API, which cuts
 * the rows. Narrowing them here instead would answer about the fifty rows
 * that happened to arrive — "no such customer" about somebody on page four —
 * and reading them off the URL is also what makes the view an operator is
 * looking at survive a reload and travel as a link.
 *
 * No standing prose above the table. This is a screen somebody opens every
 * day and looks at rather than reads: the rungs are named in the header row,
 * the count is the number of rows, and a sentence explaining either is a toll
 * paid on every visit for something learned once.
 */
export default async function AdminWorkspacesPage({ searchParams }: PageProps) {
  const sp = await searchParams;
  const { page, error } = await readWorkspaces({
    q: one(sp.q),
    state: one(sp.state),
    offset: Math.max(0, Number.parseInt(one(sp.offset), 10) || 0),
  });

  return (
    <AdminPage>
      {error ? (
        <Alert role="alert" status="danger">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Description>
              Couldn&apos;t load workspaces: {error}
            </Alert.Description>
          </Alert.Content>
        </Alert>
      ) : (
        <WorkspacesList
          action={<CreateWorkspaceDrawer />}
          workspaces={page.items}
          total={page.total}
          limit={page.limit}
          offset={page.offset}
        />
      )}
    </AdminPage>
  );
}

interface WorkspacesQuery {
  q: string;
  state: string;
  offset: number;
}

/**
 * The page the URL asked for. `limit` is left unsaid: the API's default is
 * the page size the panel wants, and repeating it here is a second place for
 * the two to stop agreeing.
 *
 * An unknown `state` is passed through rather than dropped — the API answers
 * a typo in the address bar with a 400, and silently widening it back to
 * everything would look like "no such problem exists".
 */
async function readWorkspaces(
  query: WorkspacesQuery,
): Promise<{ page: ApiPage<AdminWorkspaceSummaryWithSpend>; error: string | null }> {
  const params = new URLSearchParams();
  if (query.q) params.set("q", query.q);
  if (query.state) params.set("state", query.state as AdminWorkspaceStateFilter);
  if (query.offset > 0) params.set("offset", String(query.offset));
  const qs = params.toString();

  try {
    return {
      page: await apiJson<ApiPage<AdminWorkspaceSummaryWithSpend>>(
        qs ? `/api/admin/workspaces?${qs}` : "/api/admin/workspaces",
      ),
      error: null,
    };
  } catch (err) {
    return {
      page: { items: [], total: 0, limit: PAGE_SIZE, offset: query.offset },
      error: err instanceof ApiError ? err.message : "unavailable",
    };
  }
}
