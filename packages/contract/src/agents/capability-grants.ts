/**
 * The capability grants of one agent connection, as the Agents page reads
 * and writes them: which tool providers (connected MCP servers, webhooks,
 * workflows) and which bundles of them an agent may find with
 * `capability_search` and call with `capability_call`.
 *
 * Who uses it: `GET/PATCH /api/agents/connections[/:id]` in bcontext-api
 * (they validate and persist the grant set through the
 * `update_agent_connection_policy` RPC, migration 0102) and the agent edit
 * window in bcontext-web. What must not break: the grant set is written
 * whole — an id missing from a PATCH is a revoked grant — so both sides
 * have to send and read the same two arrays, under the same limit the RPC
 * enforces.
 */

/** Most capability (or bundle) ids one PATCH may grant; the RPC refuses more. */
export const MAX_CAPABILITY_GRANTS = 100;

/** The grant set of one agent in one workspace. */
export interface AgentCapabilityGrants {
  capability_ids: string[];
  bundle_ids: string[];
}

/** An approved, live provider the Agents page offers as a grant. */
export interface GrantableCapability {
  id: string;
  title: string;
  provider: string;
  type: string;
}

/** An approved bundle of providers, granted as one. */
export interface GrantableBundle {
  id: string;
  title: string;
}
