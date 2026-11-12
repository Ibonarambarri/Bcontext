-- 0102_restore_capability_gateway.sql
--
-- WHAT
--   Brings back the capability gateway that 0099 dropped together with Nexo
--   and the integrations: Bcontext as the MCP router of a team's coding
--   agents. An admin registers external MCP servers (URL plus a bearer or
--   header token, or OAuth; the secret lives in Supabase Vault and the row
--   holds only a `vault:<uuid>` reference), the server's tools are discovered
--   into a versioned contract, and agents are granted providers; an agent
--   then finds and calls those tools through Bcontext's own MCP endpoint
--   (`capability_search` / `capability_call`), re-authorised on every call.
--
--   Recreated, as 0098 had them:
--     tables     capability_principals, capabilities, capability_versions,
--                capability_connections, capability_bundles,
--                capability_bundle_versions, capability_bundle_items,
--                capability_grants, capability_invocations,
--                capability_rate_buckets, capability_runtime_state,
--                capability_reviews, capability_oauth_clients,
--                capability_oauth_attempts, capability_oauth_credentials
--     functions  the Vault wrappers (create_secret_or_update,
--                read_vault_secret, delete_vault_secret), the trigger
--                functions, consume_capability_rate_limit, the managed-OAuth
--                RPCs, update/remove_capability_provider
--     policy     update_agent_connection_policy with the capability grant
--                set again (role, scopes and grants in one transaction)
--
-- HOW IT WAS BUILT
--   Every table, constraint, index, trigger, policy and function body is the
--   schema-only dump of a database migrated to 0098, i.e. 0031-0035, 0046,
--   0079, 0082 and 0091 with every later alteration applied. Names are kept
--   (tables, columns, constraints, indexes, triggers) so production rows can
--   be restored from a pg_dump of the old tables with no mapping.
--
-- WHAT CHANGED AGAINST 0098
--   - No table here ever carried `organization_id`; they were always keyed by
--     `workspace_id`, which after 0100/0101 is the top level. Nothing to adapt.
--   - `update_agent_connection_policy(uuid, uuid, uuid, text, text, text[],
--     uuid[], uuid[])` admits `credentials:use` (1-8 scopes), which 0099's
--     grant-less version had added; that 5-argument version is dropped so
--     there is one policy RPC again.
--   - `capability_principals` CHECKs still admit `service_account` /
--     `connector_install` (0079): nothing writes them any more, but a restore
--     of old rows must not fail on the Slack-install principals and the
--     invocations that reference them.
--   - Active agent connections made while the gateway was gone get their
--     `agent` principal (section 10); a Nexo never comes back as one.
--
-- MUST NOT BREAK
--   Applies on a fresh database and on one that ran 0099-0101. Every function
--   is service-role only. The OAuth tables are service-role only.

begin;

-- ── 1. Tables ─────────────────────────────────────────────────────────────────

-- Column for column what 0098 left (0031-0035, 0046, 0079, 0082, 0091): a
-- pg_dump of the old tables restores into these unchanged. No table here
-- ever had an organization column, so 0100/0101 change nothing; every row
-- hangs off `workspaces` and goes with it (on delete cascade).

CREATE TABLE public.capability_principals (
    id uuid DEFAULT extensions.uuid_generate_v4() NOT NULL,
    workspace_id uuid NOT NULL,
    kind text NOT NULL,
    source_type text NOT NULL,
    source_id text NOT NULL,
    display_name text NOT NULL,
    disabled_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT capability_principals_kind_check CHECK ((kind = ANY (ARRAY['user'::text, 'agent'::text, 'team'::text, 'service_account'::text]))),
    CONSTRAINT capability_principals_source_type_check CHECK ((source_type = ANY (ARRAY['user'::text, 'agent'::text, 'agent_token'::text, 'team'::text, 'service_account'::text, 'connector_install'::text])))
);

CREATE TABLE public.capabilities (
    id uuid DEFAULT extensions.uuid_generate_v4() NOT NULL,
    workspace_id uuid NOT NULL,
    key text NOT NULL,
    type text NOT NULL,
    owner_user_id uuid,
    provider text NOT NULL,
    title text NOT NULL,
    description text DEFAULT ''::text NOT NULL,
    provenance jsonb DEFAULT '{}'::jsonb NOT NULL,
    status text DEFAULT 'draft'::text NOT NULL,
    current_version_id uuid,
    disabled_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone,
    CONSTRAINT capabilities_key_check CHECK ((key ~ '^[a-z][a-z0-9_-]{1,62}$'::text)),
    CONSTRAINT capabilities_status_check CHECK ((status = ANY (ARRAY['draft'::text, 'approved'::text, 'deprecated'::text, 'disabled'::text]))),
    CONSTRAINT capabilities_type_check CHECK ((type = ANY (ARRAY['mcp_server'::text, 'api'::text, 'workflow'::text, 'skill'::text, 'plugin'::text, 'script_or_cli'::text, 'agent'::text])))
);

CREATE TABLE public.capability_versions (
    id uuid DEFAULT extensions.uuid_generate_v4() NOT NULL,
    workspace_id uuid NOT NULL,
    capability_id uuid NOT NULL,
    version integer NOT NULL,
    environment text DEFAULT 'production'::text NOT NULL,
    contract jsonb NOT NULL,
    contract_digest text NOT NULL,
    change_summary text,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT capability_versions_version_check CHECK ((version > 0))
);

CREATE TABLE public.capability_connections (
    id uuid DEFAULT extensions.uuid_generate_v4() NOT NULL,
    workspace_id uuid NOT NULL,
    capability_id uuid NOT NULL,
    environment text DEFAULT 'production'::text NOT NULL,
    endpoint_url text NOT NULL,
    auth_type text DEFAULT 'none'::text NOT NULL,
    auth_header_name text,
    secret_ref text,
    allowed_hosts text[] DEFAULT '{}'::text[] NOT NULL,
    timeout_ms integer DEFAULT 15000 NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT capability_connections_auth_type_check CHECK ((auth_type = ANY (ARRAY['none'::text, 'oauth'::text, 'bearer'::text, 'header'::text]))),
    CONSTRAINT capability_connections_check CHECK ((((auth_type = 'none'::text) AND (secret_ref IS NULL) AND (auth_header_name IS NULL)) OR ((auth_type = 'oauth'::text) AND (secret_ref IS NULL) AND (auth_header_name IS NULL)) OR ((auth_type = 'bearer'::text) AND (secret_ref IS NOT NULL) AND (auth_header_name IS NULL)) OR ((auth_type = 'header'::text) AND (secret_ref IS NOT NULL) AND (auth_header_name IS NOT NULL)))),
    CONSTRAINT capability_connections_secret_ref_check CHECK (((secret_ref IS NULL) OR (secret_ref ~ '^vault:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'::text))),
    CONSTRAINT capability_connections_timeout_ms_check CHECK (((timeout_ms >= 1000) AND (timeout_ms <= 55000)))
);

CREATE TABLE public.capability_bundles (
    id uuid DEFAULT extensions.uuid_generate_v4() NOT NULL,
    workspace_id uuid NOT NULL,
    key text NOT NULL,
    title text NOT NULL,
    description text DEFAULT ''::text NOT NULL,
    status text DEFAULT 'draft'::text NOT NULL,
    current_version_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT capability_bundles_key_check CHECK ((key ~ '^[a-z][a-z0-9_-]{1,62}$'::text)),
    CONSTRAINT capability_bundles_status_check CHECK ((status = ANY (ARRAY['draft'::text, 'approved'::text, 'deprecated'::text, 'disabled'::text])))
);

CREATE TABLE public.capability_bundle_versions (
    id uuid DEFAULT extensions.uuid_generate_v4() NOT NULL,
    workspace_id uuid NOT NULL,
    bundle_id uuid NOT NULL,
    version integer NOT NULL,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT capability_bundle_versions_version_check CHECK ((version > 0))
);

CREATE TABLE public.capability_bundle_items (
    workspace_id uuid NOT NULL,
    bundle_version_id uuid NOT NULL,
    capability_version_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.capability_grants (
    id uuid DEFAULT extensions.uuid_generate_v4() NOT NULL,
    workspace_id uuid NOT NULL,
    principal_id uuid NOT NULL,
    capability_id uuid,
    bundle_id uuid,
    actions text[] DEFAULT ARRAY['discover'::text, 'invoke'::text] NOT NULL,
    constraints jsonb DEFAULT '{}'::jsonb NOT NULL,
    expires_at timestamp with time zone,
    revoked_at timestamp with time zone,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT capability_grants_actions_check CHECK ((actions <@ ARRAY['discover'::text, 'invoke'::text, 'admin'::text])),
    CONSTRAINT capability_grants_check CHECK ((num_nonnulls(capability_id, bundle_id) = 1))
);

CREATE TABLE public.capability_invocations (
    id uuid DEFAULT extensions.uuid_generate_v4() NOT NULL,
    workspace_id uuid NOT NULL,
    capability_id uuid NOT NULL,
    capability_version_id uuid,
    principal_id uuid,
    agent_token_id uuid,
    tool_name text NOT NULL,
    "authorization" text NOT NULL,
    status text NOT NULL,
    duration_ms integer,
    cost_microunits bigint,
    error_code text,
    idempotency_key_hash text,
    correlation_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    node_id uuid,
    CONSTRAINT capability_invocations_authorization_check CHECK (("authorization" = ANY (ARRAY['allowed'::text, 'denied'::text]))),
    CONSTRAINT capability_invocations_status_check CHECK ((status = ANY (ARRAY['started'::text, 'succeeded'::text, 'failed'::text, 'timed_out'::text, 'cancelled'::text])))
);

CREATE TABLE public.capability_rate_buckets (
    workspace_id uuid NOT NULL,
    principal_id uuid NOT NULL,
    capability_id uuid NOT NULL,
    tokens numeric NOT NULL,
    last_refill_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.capability_runtime_state (
    capability_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    consecutive_failures integer DEFAULT 0 NOT NULL,
    circuit_open_until timestamp with time zone,
    last_failure_at timestamp with time zone,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    last_checked_at timestamp with time zone,
    health_status text DEFAULT 'unknown'::text NOT NULL,
    last_error text,
    schema_drift boolean DEFAULT false NOT NULL,
    drift_detected_at timestamp with time zone,
    drift_summary jsonb,
    CONSTRAINT capability_runtime_state_health_status_check CHECK ((health_status = ANY (ARRAY['unknown'::text, 'healthy'::text, 'unhealthy'::text])))
);

CREATE TABLE public.capability_reviews (
    id uuid DEFAULT extensions.uuid_generate_v4() NOT NULL,
    workspace_id uuid NOT NULL,
    capability_id uuid NOT NULL,
    version_id uuid,
    reviewer_user_id uuid,
    decision text NOT NULL,
    comment text DEFAULT ''::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT capability_reviews_decision_check CHECK ((decision = ANY (ARRAY['approved'::text, 'rejected'::text])))
);

CREATE TABLE public.capability_oauth_clients (
    id uuid DEFAULT extensions.uuid_generate_v4() NOT NULL,
    workspace_id uuid NOT NULL,
    issuer text NOT NULL,
    redirect_uri text NOT NULL,
    secret_ref text,
    status text DEFAULT 'pending'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT capability_oauth_clients_check CHECK (((status <> 'active'::text) OR (secret_ref IS NOT NULL))),
    CONSTRAINT capability_oauth_clients_issuer_check CHECK (((char_length(issuer) >= 1) AND (char_length(issuer) <= 2048))),
    CONSTRAINT capability_oauth_clients_redirect_uri_check CHECK (((char_length(redirect_uri) >= 1) AND (char_length(redirect_uri) <= 2048))),
    CONSTRAINT capability_oauth_clients_secret_ref_check CHECK (((secret_ref IS NULL) OR (secret_ref ~ '^vault:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'::text))),
    CONSTRAINT capability_oauth_clients_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'active'::text, 'failed'::text, 'revoked'::text])))
);

CREATE TABLE public.capability_oauth_attempts (
    id uuid DEFAULT extensions.uuid_generate_v4() NOT NULL,
    workspace_id uuid NOT NULL,
    requested_by uuid,
    state_hash text NOT NULL,
    endpoint_url text NOT NULL,
    allowed_hosts text[] NOT NULL,
    secret_ref text NOT NULL,
    issuer text NOT NULL,
    resource text,
    scopes text[] DEFAULT '{}'::text[] NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    error_code text,
    expires_at timestamp with time zone NOT NULL,
    connected_at timestamp with time zone,
    consumed_at timestamp with time zone,
    capability_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT capability_oauth_attempts_allowed_hosts_check CHECK (((cardinality(allowed_hosts) >= 1) AND (cardinality(allowed_hosts) <= 20))),
    CONSTRAINT capability_oauth_attempts_allowed_hosts_check1 CHECK ((array_position(allowed_hosts, NULL::text) IS NULL)),
    CONSTRAINT capability_oauth_attempts_check CHECK ((expires_at > created_at)),
    CONSTRAINT capability_oauth_attempts_endpoint_url_check CHECK (((char_length(endpoint_url) >= 1) AND (char_length(endpoint_url) <= 4096))),
    CONSTRAINT capability_oauth_attempts_error_code_check CHECK (((error_code IS NULL) OR ((char_length(error_code) >= 1) AND (char_length(error_code) <= 200)))),
    CONSTRAINT capability_oauth_attempts_issuer_check CHECK (((char_length(issuer) >= 1) AND (char_length(issuer) <= 2048))),
    CONSTRAINT capability_oauth_attempts_resource_check CHECK (((resource IS NULL) OR ((char_length(resource) >= 1) AND (char_length(resource) <= 4096)))),
    CONSTRAINT capability_oauth_attempts_scopes_check CHECK ((cardinality(scopes) <= 100)),
    CONSTRAINT capability_oauth_attempts_scopes_check1 CHECK ((array_position(scopes, NULL::text) IS NULL)),
    CONSTRAINT capability_oauth_attempts_secret_ref_check CHECK ((secret_ref ~ '^vault:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'::text)),
    CONSTRAINT capability_oauth_attempts_state_hash_check CHECK ((state_hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT capability_oauth_attempts_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'authorized'::text, 'connected'::text, 'failed'::text, 'expired'::text, 'cancelled'::text])))
);

CREATE TABLE public.capability_oauth_credentials (
    id uuid DEFAULT extensions.uuid_generate_v4() NOT NULL,
    workspace_id uuid NOT NULL,
    connection_id uuid NOT NULL,
    attempt_id uuid NOT NULL,
    secret_ref text NOT NULL,
    issuer text NOT NULL,
    resource text,
    scopes text[] DEFAULT '{}'::text[] NOT NULL,
    token_expires_at timestamp with time zone,
    status text DEFAULT 'active'::text NOT NULL,
    refresh_lease_token uuid,
    refresh_lease_until timestamp with time zone,
    revision integer DEFAULT 1 NOT NULL,
    last_refreshed_at timestamp with time zone,
    last_error text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT capability_oauth_credentials_check CHECK ((((status = 'refreshing'::text) AND (refresh_lease_token IS NOT NULL) AND (refresh_lease_until IS NOT NULL)) OR ((status <> 'refreshing'::text) AND (refresh_lease_token IS NULL) AND (refresh_lease_until IS NULL)))),
    CONSTRAINT capability_oauth_credentials_issuer_check CHECK (((char_length(issuer) >= 1) AND (char_length(issuer) <= 2048))),
    CONSTRAINT capability_oauth_credentials_last_error_check CHECK (((last_error IS NULL) OR (char_length(last_error) <= 4000))),
    CONSTRAINT capability_oauth_credentials_resource_check CHECK (((resource IS NULL) OR ((char_length(resource) >= 1) AND (char_length(resource) <= 4096)))),
    CONSTRAINT capability_oauth_credentials_revision_check CHECK ((revision > 0)),
    CONSTRAINT capability_oauth_credentials_scopes_check CHECK ((cardinality(scopes) <= 100)),
    CONSTRAINT capability_oauth_credentials_scopes_check1 CHECK ((array_position(scopes, NULL::text) IS NULL)),
    CONSTRAINT capability_oauth_credentials_secret_ref_check CHECK ((secret_ref ~ '^vault:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'::text)),
    CONSTRAINT capability_oauth_credentials_status_check CHECK ((status = ANY (ARRAY['active'::text, 'refreshing'::text, 'needs_reauth'::text, 'revoked'::text, 'failed'::text])))
);

-- ── 2. Keys and uniques ───────────────────────────────────────────────────────

-- The composite (id, workspace_id) uniques are what the cross-table FKs
-- below point at: a child row can only reference a parent in its own
-- workspace.
ALTER TABLE ONLY public.capability_principals
    ADD CONSTRAINT capability_principals_id_workspace_id_key UNIQUE (id, workspace_id);
ALTER TABLE ONLY public.capability_principals
    ADD CONSTRAINT capability_principals_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.capability_principals
    ADD CONSTRAINT capability_principals_workspace_id_source_type_source_id_key UNIQUE (workspace_id, source_type, source_id);
ALTER TABLE ONLY public.capabilities
    ADD CONSTRAINT capabilities_id_workspace_id_key UNIQUE (id, workspace_id);
ALTER TABLE ONLY public.capabilities
    ADD CONSTRAINT capabilities_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.capability_versions
    ADD CONSTRAINT capability_versions_capability_id_contract_digest_key UNIQUE (capability_id, contract_digest);
ALTER TABLE ONLY public.capability_versions
    ADD CONSTRAINT capability_versions_capability_id_version_key UNIQUE (capability_id, version);
ALTER TABLE ONLY public.capability_versions
    ADD CONSTRAINT capability_versions_id_capability_id_workspace_id_key UNIQUE (id, capability_id, workspace_id);
ALTER TABLE ONLY public.capability_versions
    ADD CONSTRAINT capability_versions_id_workspace_id_key UNIQUE (id, workspace_id);
ALTER TABLE ONLY public.capability_versions
    ADD CONSTRAINT capability_versions_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.capability_connections
    ADD CONSTRAINT capability_connections_capability_id_environment_key UNIQUE (capability_id, environment);
ALTER TABLE ONLY public.capability_connections
    ADD CONSTRAINT capability_connections_id_workspace_key UNIQUE (id, workspace_id);
ALTER TABLE ONLY public.capability_connections
    ADD CONSTRAINT capability_connections_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.capability_bundles
    ADD CONSTRAINT capability_bundles_id_workspace_id_key UNIQUE (id, workspace_id);
ALTER TABLE ONLY public.capability_bundles
    ADD CONSTRAINT capability_bundles_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.capability_bundles
    ADD CONSTRAINT capability_bundles_workspace_id_key_key UNIQUE (workspace_id, key);
ALTER TABLE ONLY public.capability_bundle_versions
    ADD CONSTRAINT capability_bundle_versions_bundle_id_version_key UNIQUE (bundle_id, version);
ALTER TABLE ONLY public.capability_bundle_versions
    ADD CONSTRAINT capability_bundle_versions_id_bundle_id_workspace_id_key UNIQUE (id, bundle_id, workspace_id);
ALTER TABLE ONLY public.capability_bundle_versions
    ADD CONSTRAINT capability_bundle_versions_id_workspace_id_key UNIQUE (id, workspace_id);
ALTER TABLE ONLY public.capability_bundle_versions
    ADD CONSTRAINT capability_bundle_versions_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.capability_bundle_items
    ADD CONSTRAINT capability_bundle_items_pkey PRIMARY KEY (bundle_version_id, capability_version_id);
ALTER TABLE ONLY public.capability_grants
    ADD CONSTRAINT capability_grants_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.capability_invocations
    ADD CONSTRAINT capability_invocations_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.capability_rate_buckets
    ADD CONSTRAINT capability_rate_buckets_pkey PRIMARY KEY (workspace_id, principal_id, capability_id);
ALTER TABLE ONLY public.capability_runtime_state
    ADD CONSTRAINT capability_runtime_state_pkey PRIMARY KEY (capability_id);
ALTER TABLE ONLY public.capability_reviews
    ADD CONSTRAINT capability_reviews_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.capability_oauth_clients
    ADD CONSTRAINT capability_oauth_clients_id_workspace_id_key UNIQUE (id, workspace_id);
ALTER TABLE ONLY public.capability_oauth_clients
    ADD CONSTRAINT capability_oauth_clients_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.capability_oauth_clients
    ADD CONSTRAINT capability_oauth_clients_workspace_id_issuer_redirect_uri_key UNIQUE (workspace_id, issuer, redirect_uri);
ALTER TABLE ONLY public.capability_oauth_attempts
    ADD CONSTRAINT capability_oauth_attempts_id_workspace_id_key UNIQUE (id, workspace_id);
ALTER TABLE ONLY public.capability_oauth_attempts
    ADD CONSTRAINT capability_oauth_attempts_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.capability_oauth_attempts
    ADD CONSTRAINT capability_oauth_attempts_state_hash_key UNIQUE (state_hash);
ALTER TABLE ONLY public.capability_oauth_credentials
    ADD CONSTRAINT capability_oauth_credentials_attempt_id_key UNIQUE (attempt_id);
ALTER TABLE ONLY public.capability_oauth_credentials
    ADD CONSTRAINT capability_oauth_credentials_connection_id_key UNIQUE (connection_id);
ALTER TABLE ONLY public.capability_oauth_credentials
    ADD CONSTRAINT capability_oauth_credentials_id_workspace_id_key UNIQUE (id, workspace_id);
ALTER TABLE ONLY public.capability_oauth_credentials
    ADD CONSTRAINT capability_oauth_credentials_pkey PRIMARY KEY (id);

-- ── 3. Indexes ────────────────────────────────────────────────────────────────

CREATE INDEX capability_principals_lookup_idx ON public.capability_principals USING btree (workspace_id, source_type, source_id) WHERE (disabled_at IS NULL);
CREATE UNIQUE INDEX capabilities_workspace_active_key_idx ON public.capabilities USING btree (workspace_id, key) WHERE (deleted_at IS NULL);
CREATE INDEX capabilities_workspace_deleted_idx ON public.capabilities USING btree (workspace_id, deleted_at) WHERE (deleted_at IS NOT NULL);
CREATE INDEX capabilities_workspace_status_idx ON public.capabilities USING btree (workspace_id, status);
CREATE INDEX capability_versions_capability_idx ON public.capability_versions USING btree (capability_id, version DESC);
CREATE INDEX capability_grants_principal_idx ON public.capability_grants USING btree (principal_id) WHERE (revoked_at IS NULL);
CREATE INDEX capability_invocations_capability_created_idx ON public.capability_invocations USING btree (capability_id, created_at DESC);
CREATE INDEX capability_invocations_node_idx ON public.capability_invocations USING btree (node_id) WHERE (node_id IS NOT NULL);
CREATE INDEX capability_invocations_workspace_created_idx ON public.capability_invocations USING btree (workspace_id, created_at DESC);
CREATE INDEX capability_reviews_capability_created_idx ON public.capability_reviews USING btree (capability_id, created_at DESC);
CREATE INDEX capability_oauth_clients_workspace_status_idx ON public.capability_oauth_clients USING btree (workspace_id, status);
CREATE INDEX capability_oauth_attempts_capability_idx ON public.capability_oauth_attempts USING btree (capability_id) WHERE (capability_id IS NOT NULL);
CREATE INDEX capability_oauth_attempts_expires_idx ON public.capability_oauth_attempts USING btree (expires_at) WHERE (consumed_at IS NULL);
CREATE INDEX capability_oauth_attempts_workspace_status_idx ON public.capability_oauth_attempts USING btree (workspace_id, status, created_at DESC);
CREATE INDEX capability_oauth_credentials_expires_idx ON public.capability_oauth_credentials USING btree (token_expires_at) WHERE ((status = ANY (ARRAY['active'::text, 'refreshing'::text])) AND (token_expires_at IS NOT NULL));
CREATE INDEX capability_oauth_credentials_refresh_lease_idx ON public.capability_oauth_credentials USING btree (refresh_lease_until) WHERE (refresh_lease_token IS NOT NULL);
CREATE INDEX capability_oauth_credentials_workspace_status_idx ON public.capability_oauth_credentials USING btree (workspace_id, status);

-- ── 4. Functions ──────────────────────────────────────────────────────────────


-- Vault wrappers (0034). The API reaches Vault only through these
-- service-role RPCs: `create_secret_or_update` writes a named secret
-- (rotation keeps its id), `read_vault_secret` / `delete_vault_secret`
-- address one by id. 0099 dropped them with the gateway.

CREATE OR REPLACE FUNCTION public.create_secret_or_update(secret_value text, secret_name text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_secret_id uuid;
  v_secret_name text;
begin
  v_secret_name := pg_catalog.btrim(secret_name);
  if secret_value is null or pg_catalog.octet_length(secret_value) = 0 then
    raise exception using errcode = '22023', message = 'secret value is required';
  end if;
  if pg_catalog.octet_length(secret_value) > 1048576 then
    raise exception using errcode = '22023', message = 'secret value is too large';
  end if;
  if v_secret_name is null or pg_catalog.char_length(v_secret_name) = 0
     or pg_catalog.char_length(v_secret_name) > 200 then
    raise exception using errcode = '22023', message = 'valid secret name is required';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(v_secret_name, 0::bigint)
  );

  select s.id
    into v_secret_id
    from vault.secrets s
    where s.name = v_secret_name
    order by s.created_at desc
    limit 1;

  if v_secret_id is null then
    v_secret_id := vault.create_secret(
      secret_value,
      v_secret_name,
      'Bcontext server-managed secret',
      null::uuid
    );
  else
    perform vault.update_secret(
      v_secret_id,
      secret_value,
      v_secret_name,
      'Bcontext server-managed secret',
      null::uuid
    );
  end if;

  return v_secret_id;
end;
$function$;

revoke all on function public.create_secret_or_update(text, text) from public, anon, authenticated;
grant execute on function public.create_secret_or_update(text, text) to service_role;

CREATE OR REPLACE FUNCTION public.read_vault_secret(secret_id uuid)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_secret text;
begin
  select s.decrypted_secret
    into v_secret
    from vault.decrypted_secrets s
    where s.id = secret_id
    limit 1;
  return v_secret;
end;
$function$;

revoke all on function public.read_vault_secret(uuid) from public, anon, authenticated;
grant execute on function public.read_vault_secret(uuid) to service_role;

CREATE OR REPLACE FUNCTION public.delete_vault_secret(secret_id uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_deleted integer;
begin
  delete from vault.secrets where id = secret_id;
  get diagnostics v_deleted = row_count;
  return v_deleted > 0;
end;
$function$;

revoke all on function public.delete_vault_secret(uuid) from public, anon, authenticated;
grant execute on function public.delete_vault_secret(uuid) to service_role;

-- Trigger functions: a deleted or rotated `secret_ref` takes its Vault row
-- with it (0034); a grant only ever points at an approved, live target
-- (0035); a bundle's current version is complete, and what it pins cannot
-- change underneath it (0035).

CREATE OR REPLACE FUNCTION public.delete_oauth_vault_secret_on_row_delete()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  if old.secret_ref is not null
     and old.secret_ref ~ '^vault:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    delete from vault.secrets
    where id = pg_catalog.substring(old.secret_ref, 7)::uuid;
  end if;
  return old;
end;
$function$;

revoke all on function public.delete_oauth_vault_secret_on_row_delete() from public, anon, authenticated;
grant execute on function public.delete_oauth_vault_secret_on_row_delete() to service_role;

CREATE OR REPLACE FUNCTION public.validate_active_capability_grant()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  if new.revoked_at is not null then
    return new;
  end if;

  if new.capability_id is not null then
    perform c.id
    from public.capabilities c
    where c.id = new.capability_id
      and c.workspace_id = new.workspace_id
      and c.status = 'approved'
      and c.disabled_at is null
      and c.deleted_at is null
    for share;
    if not found then
      raise exception using errcode = '23514', message = 'capability_grant_target_unavailable';
    end if;
  else
    perform b.id
    from public.capability_bundles b
    where b.id = new.bundle_id
      and b.workspace_id = new.workspace_id
      and b.status = 'approved'
      and b.current_version_id is not null
    for share;
    if not found then
      raise exception using errcode = '23514', message = 'capability_grant_target_unavailable';
    end if;
  end if;
  return new;
end;
$function$;

revoke all on function public.validate_active_capability_grant() from public, anon, authenticated;
grant execute on function public.validate_active_capability_grant() to service_role;

CREATE OR REPLACE FUNCTION public.validate_capability_bundle_current_version()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_capability record;
  v_item_count integer := 0;
begin
  if new.current_version_id is null then
    if new.status = 'approved' then
      raise exception using errcode = '23514', message = 'capability_bundle_current_version_required';
    end if;
    return new;
  end if;
  if not exists (
    select 1
    from public.capability_bundle_versions bv
    where bv.id = new.current_version_id
      and bv.bundle_id = new.id
      and bv.workspace_id = new.workspace_id
  ) then
    raise exception using errcode = '23514', message = 'capability_bundle_current_version_invalid';
  end if;

  for v_capability in
    select c.id, c.current_version_id, c.status, c.disabled_at, c.deleted_at,
           cv.id as pinned_version_id
    from public.capability_bundle_items bi
    join public.capability_versions cv
      on cv.id = bi.capability_version_id
     and cv.workspace_id = bi.workspace_id
    join public.capabilities c
      on c.id = cv.capability_id
     and c.workspace_id = cv.workspace_id
    where bi.workspace_id = new.workspace_id
      and bi.bundle_version_id = new.current_version_id
    order by c.id
    for share of c
  loop
    v_item_count := v_item_count + 1;
    if v_capability.deleted_at is not null
       or v_capability.current_version_id is distinct from v_capability.pinned_version_id
       or (new.status = 'approved' and (
         v_capability.status <> 'approved' or v_capability.disabled_at is not null
       )) then
      raise exception using errcode = '23514', message = 'capability_bundle_provider_stale';
    end if;
  end loop;
  if v_item_count = 0 then
    raise exception using errcode = '23514', message = 'capability_bundle_items_required';
  end if;
  return new;
end;
$function$;

revoke all on function public.validate_capability_bundle_current_version() from public, anon, authenticated;
grant execute on function public.validate_capability_bundle_current_version() to service_role;

CREATE OR REPLACE FUNCTION public.protect_current_bundle_items()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_is_current boolean;
begin
  if tg_op in ('UPDATE', 'DELETE') then
    select b.current_version_id = old.bundle_version_id
      into v_is_current
    from public.capability_bundle_versions bv
    join public.capability_bundles b
      on b.id = bv.bundle_id and b.workspace_id = bv.workspace_id
    where bv.id = old.bundle_version_id
      and bv.workspace_id = old.workspace_id
    for share of b;
    if found and v_is_current then
      raise exception using errcode = '55000', message = 'capability_bundle_current_items_immutable';
    end if;
  end if;
  if tg_op in ('INSERT', 'UPDATE') then
    select b.current_version_id = new.bundle_version_id
      into v_is_current
    from public.capability_bundle_versions bv
    join public.capability_bundles b
      on b.id = bv.bundle_id and b.workspace_id = bv.workspace_id
    where bv.id = new.bundle_version_id
      and bv.workspace_id = new.workspace_id
    for share of b;
    if found and v_is_current then
      raise exception using errcode = '55000', message = 'capability_bundle_current_items_immutable';
    end if;
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$function$;

revoke all on function public.protect_current_bundle_items() from public, anon, authenticated;
grant execute on function public.protect_current_bundle_items() to service_role;

CREATE OR REPLACE FUNCTION public.protect_current_bundle_capability()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  if (
    old.current_version_id is distinct from new.current_version_id
    or (old.status = 'approved' and new.status <> 'approved')
    or (old.deleted_at is null and new.deleted_at is not null)
    or (old.disabled_at is null and new.disabled_at is not null)
  ) and exists (
    select 1
    from public.capability_bundle_items bi
    join public.capability_versions cv
      on cv.id = bi.capability_version_id
     and cv.workspace_id = bi.workspace_id
    join public.capability_bundle_versions bv
      on bv.id = bi.bundle_version_id
     and bv.workspace_id = bi.workspace_id
    join public.capability_bundles b
      on b.id = bv.bundle_id
     and b.workspace_id = bv.workspace_id
     and b.current_version_id = bv.id
    where cv.capability_id = old.id
      and cv.workspace_id = old.workspace_id
  ) then
    raise exception using errcode = '55000', message = 'capability_provider_used_by_bundle';
  end if;
  return new;
end;
$function$;

revoke all on function public.protect_current_bundle_capability() from public, anon, authenticated;
grant execute on function public.protect_current_bundle_capability() to service_role;

-- The gateway's token bucket (0031): one row per (principal, capability),
-- refilled lazily under a row lock, so concurrent calls cannot both spend
-- the last token.

CREATE OR REPLACE FUNCTION public.consume_capability_rate_limit(p_workspace_id uuid, p_principal_id uuid, p_capability_id uuid, p_capacity integer DEFAULT 20, p_refill_per_second numeric DEFAULT 0.25)
 RETURNS TABLE(allowed boolean, retry_after_sec integer, remaining integer, capacity integer)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_bucket capability_rate_buckets%rowtype;
  v_available numeric;
begin
  if p_capacity < 1 or p_refill_per_second <= 0 then
    raise exception 'invalid capability rate-limit configuration';
  end if;

  insert into capability_rate_buckets (
    workspace_id, principal_id, capability_id, tokens, last_refill_at
  ) values (
    p_workspace_id, p_principal_id, p_capability_id, p_capacity, now()
  ) on conflict do nothing;

  select * into v_bucket
  from capability_rate_buckets
  where workspace_id = p_workspace_id
    and principal_id = p_principal_id
    and capability_id = p_capability_id
  for update;

  v_available := least(
    p_capacity::numeric,
    v_bucket.tokens + extract(epoch from (now() - v_bucket.last_refill_at)) * p_refill_per_second
  );

  if v_available < 1 then
    update capability_rate_buckets
    set tokens = v_available, last_refill_at = now()
    where workspace_id = p_workspace_id
      and principal_id = p_principal_id
      and capability_id = p_capability_id;
    return query select
      false,
      greatest(1, ceil((1 - v_available) / p_refill_per_second)::integer),
      0,
      p_capacity;
    return;
  end if;

  update capability_rate_buckets
  set tokens = v_available - 1, last_refill_at = now()
  where workspace_id = p_workspace_id
    and principal_id = p_principal_id
    and capability_id = p_capability_id;
  return query select true, 0, floor(v_available - 1)::integer, p_capacity;
end;
$function$;

revoke all on function public.consume_capability_rate_limit(uuid, uuid, uuid, integer, numeric) from public, anon, authenticated;
grant execute on function public.consume_capability_rate_limit(uuid, uuid, uuid, integer, numeric) to service_role;

-- Managed OAuth (0034, 0035): attaching an authorized attempt to a
-- connection, registering a provider from one in a single transaction, and
-- the sweep the worker queue `capability.oauth-expire` calls every five
-- minutes (pg_cron used to; 0097 moved it).

CREATE OR REPLACE FUNCTION public.attach_capability_oauth_credential(p_workspace_id uuid, p_user_id uuid, p_attempt_id uuid, p_connection_id uuid, p_capability_id uuid, p_endpoint_url text, p_token_expires_at timestamp with time zone)
 RETURNS public.capability_oauth_credentials
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_attempt public.capability_oauth_attempts%rowtype;
  v_connection public.capability_connections%rowtype;
  v_credential public.capability_oauth_credentials%rowtype;
begin
  select a.* into v_attempt
  from public.capability_oauth_attempts a
  where a.id = p_attempt_id
    and a.workspace_id = p_workspace_id
    and a.requested_by = p_user_id
  for update;

  if not found
     or v_attempt.status <> 'authorized'
     or v_attempt.endpoint_url <> p_endpoint_url
     or v_attempt.expires_at <= pg_catalog.now() then
    raise exception using errcode = 'P0001', message = 'oauth_attempt_not_attachable';
  end if;

  select c.* into v_connection
  from public.capability_connections c
  where c.id = p_connection_id
    and c.workspace_id = p_workspace_id
    and c.capability_id = p_capability_id
  for update;

  if not found
     or v_connection.auth_type <> 'oauth'
     or v_connection.secret_ref is not null
     or v_connection.endpoint_url <> p_endpoint_url then
    raise exception using errcode = 'P0001', message = 'oauth_connection_not_attachable';
  end if;

  insert into public.capability_oauth_credentials (
    workspace_id, connection_id, attempt_id, secret_ref, issuer, resource,
    scopes, token_expires_at, status
  ) values (
    p_workspace_id, p_connection_id, p_attempt_id, v_attempt.secret_ref,
    v_attempt.issuer, v_attempt.resource, v_attempt.scopes,
    p_token_expires_at, 'active'
  )
  returning * into v_credential;

  update public.capability_oauth_attempts
  set status = 'connected', consumed_at = pg_catalog.now(),
      capability_id = p_capability_id, error_code = null,
      updated_at = pg_catalog.now()
  where id = p_attempt_id
    and workspace_id = p_workspace_id
    and status = 'authorized';

  if not found then
    raise exception using errcode = '40001', message = 'oauth_attempt_raced';
  end if;

  return v_credential;
end;
$function$;

revoke all on function public.attach_capability_oauth_credential(uuid, uuid, uuid, uuid, uuid, text, timestamptz) from public, anon, authenticated;
grant execute on function public.attach_capability_oauth_credential(uuid, uuid, uuid, uuid, uuid, text, timestamptz) to service_role;

CREATE OR REPLACE FUNCTION public.register_capability_with_oauth(p_workspace_id uuid, p_user_id uuid, p_attempt_id uuid, p_expected_endpoint_url text, p_key text, p_provider text, p_title text, p_description text, p_provenance jsonb, p_environment text, p_contract jsonb, p_contract_digest text, p_change_summary text, p_status text, p_timeout_ms integer)
 RETURNS TABLE(capability_id uuid, version_id uuid, connection_id uuid, created boolean)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_attempt public.capability_oauth_attempts%rowtype;
  v_capability_id uuid;
  v_version_id uuid;
  v_connection_id uuid;
  v_secret_bundle jsonb;
  v_token_expires_at timestamptz;
begin
  if p_status not in ('draft', 'approved') then
    raise exception using errcode = '22023', message = 'oauth_capability_status_invalid';
  end if;
  if p_timeout_ms < 1000 or p_timeout_ms > 55000 then
    raise exception using errcode = '22023', message = 'oauth_capability_timeout_invalid';
  end if;
  if not exists (
    select 1
    from public.memberships m
    where m.workspace_id = p_workspace_id
      and m.user_id = p_user_id
      and m.role in ('owner', 'admin')
  ) then
    raise exception using errcode = '42501', message = 'oauth_admin_required';
  end if;

  select a.* into v_attempt
  from public.capability_oauth_attempts a
  where a.id = p_attempt_id
    and a.workspace_id = p_workspace_id
    and a.requested_by = p_user_id
  for update;

  if not found then
    raise exception using errcode = 'P0001', message = 'oauth_attempt_not_attachable';
  end if;

  -- Safe replay after the transaction committed but its HTTP response was
  -- lost. Require the immutable request fields to match before returning it.
  if v_attempt.status = 'connected' and v_attempt.capability_id is not null then
    if v_attempt.endpoint_url <> p_expected_endpoint_url then
      raise exception using errcode = 'P0001', message = 'oauth_registration_mismatch';
    end if;
    select c.id, cv.id, cc.id
      into v_capability_id, v_version_id, v_connection_id
    from public.capabilities c
    join public.capability_versions cv
      on cv.id = c.current_version_id
     and cv.capability_id = c.id
     and cv.workspace_id = c.workspace_id
    join public.capability_connections cc
      on cc.capability_id = c.id
     and cc.workspace_id = c.workspace_id
     and cc.environment = p_environment
    join public.capability_oauth_credentials oc
      on oc.connection_id = cc.id
     and oc.workspace_id = c.workspace_id
     and oc.attempt_id = v_attempt.id
    where c.id = v_attempt.capability_id
      and c.workspace_id = p_workspace_id
      and c.key = p_key
      and c.type = 'mcp_server'
      and c.provider = p_provider
      and c.title = p_title
      and c.description = p_description
      and c.provenance = p_provenance
      and c.status = p_status
      and cv.environment = p_environment
      and cv.contract = p_contract
      and cv.contract_digest = p_contract_digest
      and cv.change_summary is not distinct from p_change_summary
      and cc.endpoint_url = v_attempt.endpoint_url
      and cc.auth_type = 'oauth'
      and cc.secret_ref is null
      and cc.timeout_ms = p_timeout_ms;

    if not found then
      raise exception using errcode = 'P0001', message = 'oauth_registration_mismatch';
    end if;

    return query select v_capability_id, v_version_id, v_connection_id, false;
    return;
  end if;

  if v_attempt.status <> 'authorized'
     or v_attempt.consumed_at is not null
     or v_attempt.capability_id is not null
     or v_attempt.expires_at <= pg_catalog.now()
     or v_attempt.endpoint_url <> p_expected_endpoint_url then
    raise exception using errcode = 'P0001', message = 'oauth_attempt_not_attachable';
  end if;

  begin
    select s.decrypted_secret::jsonb
      into v_secret_bundle
    from vault.decrypted_secrets s
    where s.id = pg_catalog.replace(v_attempt.secret_ref, 'vault:', '')::uuid
    limit 1;
  exception when others then
    raise exception using errcode = 'P0001', message = 'oauth_secret_unavailable';
  end;
  if v_secret_bundle is null
     or coalesce(v_secret_bundle #>> '{tokens,access_token}', '') = ''
     or pg_catalog.lower(coalesce(v_secret_bundle #>> '{tokens,token_type}', '')) <> 'bearer' then
    raise exception using errcode = 'P0001', message = 'oauth_secret_unavailable';
  end if;
  begin
    v_token_expires_at := nullif(v_secret_bundle ->> 'tokenExpiresAt', '')::timestamptz;
  exception when others then
    raise exception using errcode = 'P0001', message = 'oauth_secret_unavailable';
  end;

  insert into public.capabilities (
    workspace_id, key, type, owner_user_id, provider, title, description,
    provenance, status
  ) values (
    p_workspace_id, p_key, 'mcp_server', p_user_id, p_provider, p_title,
    p_description, p_provenance, 'draft'
  )
  returning id into v_capability_id;

  insert into public.capability_versions (
    workspace_id, capability_id, version, environment, contract,
    contract_digest, change_summary, created_by
  ) values (
    p_workspace_id, v_capability_id, 1, p_environment, p_contract,
    p_contract_digest, p_change_summary, p_user_id
  )
  returning id into v_version_id;

  -- Endpoint and egress hosts come from the server-validated attempt, never
  -- from mutable browser payload fields.
  insert into public.capability_connections (
    workspace_id, capability_id, environment, endpoint_url, auth_type,
    auth_header_name, secret_ref, allowed_hosts, timeout_ms
  ) values (
    p_workspace_id, v_capability_id, p_environment, v_attempt.endpoint_url,
    'oauth', null, null, v_attempt.allowed_hosts, p_timeout_ms
  )
  returning id into v_connection_id;

  insert into public.capability_oauth_credentials (
    workspace_id, connection_id, attempt_id, secret_ref, issuer, resource,
    scopes, token_expires_at, status
  ) values (
    p_workspace_id, v_connection_id, v_attempt.id, v_attempt.secret_ref,
    v_attempt.issuer, v_attempt.resource, v_attempt.scopes,
    v_token_expires_at, 'active'
  );

  update public.capability_oauth_attempts
  set status = 'connected', consumed_at = pg_catalog.now(),
      capability_id = v_capability_id, error_code = null,
      updated_at = pg_catalog.now()
  where id = v_attempt.id
    and workspace_id = p_workspace_id
    and status = 'authorized';

  if not found then
    raise exception using errcode = '40001', message = 'oauth_attempt_raced';
  end if;

  update public.capabilities
  set current_version_id = v_version_id, status = p_status,
      disabled_at = null, updated_at = pg_catalog.now()
  where id = v_capability_id
    and workspace_id = p_workspace_id;

  if not found then
    raise exception using errcode = '40001', message = 'oauth_capability_finalize_raced';
  end if;

  return query select v_capability_id, v_version_id, v_connection_id, true;
end;
$function$;

revoke all on function public.register_capability_with_oauth(uuid, uuid, uuid, text, text, text, text, text, jsonb, text, jsonb, text, text, text, integer) from public, anon, authenticated;
grant execute on function public.register_capability_with_oauth(uuid, uuid, uuid, text, text, text, text, text, jsonb, text, jsonb, text, text, text, integer) to service_role;

CREATE OR REPLACE FUNCTION public.expire_capability_oauth_attempts(p_workspace_id uuid, p_now timestamp with time zone, p_limit integer DEFAULT 100)
 RETURNS TABLE(attempt_id uuid, secret_ref text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_attempt record;
  v_limit integer;
begin
  if p_now is null then
    raise exception using errcode = '22023', message = 'expiry time is required';
  end if;
  v_limit := least(greatest(coalesce(p_limit, 100), 1), 100);

  for v_attempt in
    select a.id, a.secret_ref
    from public.capability_oauth_attempts a
    where (p_workspace_id is null or a.workspace_id = p_workspace_id)
      and a.status in ('pending', 'authorized')
      and a.expires_at <= p_now
    order by a.expires_at, a.id
    limit v_limit
    for update skip locked
  loop
    update public.capability_oauth_attempts a
    set status = 'expired',
        error_code = 'oauth_attempt_expired',
        updated_at = pg_catalog.now()
    where a.id = v_attempt.id
      and (p_workspace_id is null or a.workspace_id = p_workspace_id)
      and a.status in ('pending', 'authorized');

    delete from vault.secrets v
    where v.id = pg_catalog.substring(v_attempt.secret_ref, 7)::uuid;

    attempt_id := v_attempt.id;
    secret_ref := v_attempt.secret_ref;
    return next;
  end loop;
end;
$function$;

revoke all on function public.expire_capability_oauth_attempts(uuid, timestamptz, integer) from public, anon, authenticated;
grant execute on function public.expire_capability_oauth_attempts(uuid, timestamptz, integer) to service_role;

-- Provider lifecycle (0035): edit a provider (a material change re-drafts
-- it and revokes its grants) and remove one (grants revoked, connection and
-- credential deleted, row tombstoned).

CREATE OR REPLACE FUNCTION public.update_capability_provider(p_workspace_id uuid, p_user_id uuid, p_capability_id uuid, p_expected_updated_at timestamp with time zone, p_provider text, p_title text, p_description text, p_provenance jsonb, p_environment text, p_contract jsonb, p_contract_digest text, p_endpoint_url text, p_auth_type text, p_auth_header_name text, p_secret_ref text, p_allowed_hosts text[], p_timeout_ms integer, p_preserve_credential boolean, p_oauth_attempt_id uuid DEFAULT NULL::uuid)
 RETURNS TABLE(capability_id uuid, version_id uuid, connection_id uuid, grants_revoked integer, material_change boolean)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_capability public.capabilities%rowtype;
  v_connection public.capability_connections%rowtype;
  v_attempt public.capability_oauth_attempts%rowtype;
  v_current_digest text;
  v_version_id uuid;
  v_secret_ref text;
  v_secret_bundle jsonb;
  v_token_expires_at timestamptz;
  v_material_change boolean;
  v_grants_revoked integer := 0;
begin
  if not exists (
    select 1
    from public.memberships m
    where m.workspace_id = p_workspace_id
      and m.user_id = p_user_id
      and m.role in ('owner', 'admin')
  ) then
    raise exception using errcode = '42501', message = 'capability_admin_required';
  end if;

  if p_environment is null or pg_catalog.char_length(p_environment) not between 1 and 50
     or p_endpoint_url is null or pg_catalog.char_length(p_endpoint_url) not between 1 and 4096
     or p_auth_type not in ('none', 'oauth', 'bearer', 'header')
     or p_allowed_hosts is null or pg_catalog.cardinality(p_allowed_hosts) not between 1 and 20
     or pg_catalog.array_position(p_allowed_hosts, null) is not null
     or p_timeout_ms not between 1000 and 55000
     or p_preserve_credential is null then
    raise exception using errcode = '22023', message = 'capability_provider_input_invalid';
  end if;

  -- Match the 0034 attach RPC lock order (attempt before connection) so an
  -- OAuth reconnect cannot deadlock with an older attach request.
  if p_auth_type = 'oauth' and not p_preserve_credential then
    if p_oauth_attempt_id is null then
      raise exception using errcode = '22023', message = 'capability_oauth_attempt_required';
    end if;
    select a.* into v_attempt
    from public.capability_oauth_attempts a
    where a.id = p_oauth_attempt_id
      and a.workspace_id = p_workspace_id
      and a.requested_by = p_user_id
    for update;
    if not found
       or v_attempt.status <> 'authorized'
       or v_attempt.consumed_at is not null
       or v_attempt.capability_id is not null
       or v_attempt.expires_at <= pg_catalog.now()
       or v_attempt.endpoint_url <> p_endpoint_url
       or v_attempt.allowed_hosts is distinct from p_allowed_hosts then
      raise exception using errcode = 'P0001', message = 'oauth_attempt_not_attachable';
    end if;
  end if;

  select c.* into v_capability
  from public.capabilities c
  where c.id = p_capability_id
    and c.workspace_id = p_workspace_id
  for update;

  if not found or v_capability.deleted_at is not null then
    raise exception using errcode = 'P0002', message = 'capability_provider_not_found';
  end if;
  if p_expected_updated_at is not null
     and v_capability.updated_at is distinct from p_expected_updated_at then
    raise exception using errcode = '40001', message = 'capability_provider_stale';
  end if;
  if v_capability.type not in ('mcp_server', 'api', 'workflow') then
    raise exception using errcode = '22023', message = 'capability_provider_not_executable';
  end if;

  select cc.* into v_connection
  from public.capability_connections cc
  where cc.capability_id = p_capability_id
    and cc.workspace_id = p_workspace_id
    and cc.environment = p_environment
  for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'capability_connection_not_found';
  end if;

  select cv.contract_digest into v_current_digest
  from public.capability_versions cv
  where cv.id = v_capability.current_version_id
    and cv.capability_id = v_capability.id
    and cv.workspace_id = v_capability.workspace_id;
  if not found then
    raise exception using errcode = 'P0002', message = 'capability_version_not_found';
  end if;

  v_secret_ref := p_secret_ref;
  if p_preserve_credential then
    if p_oauth_attempt_id is not null then
      raise exception using errcode = '22023', message = 'capability_credential_preserve_invalid';
    end if;
    if p_auth_type = 'oauth' then
      if v_connection.auth_type <> 'oauth'
         or v_connection.endpoint_url <> p_endpoint_url
         or v_connection.allowed_hosts is distinct from p_allowed_hosts
         or not exists (
           select 1
           from public.capability_oauth_credentials oc
           where oc.workspace_id = p_workspace_id
             and oc.connection_id = v_connection.id
             and oc.status in ('active', 'refreshing')
         ) then
        raise exception using errcode = '22023', message = 'capability_credential_preserve_invalid';
      end if;
      v_secret_ref := null;
    elsif p_auth_type in ('bearer', 'header') then
      if v_connection.auth_type <> p_auth_type
         or v_connection.endpoint_url <> p_endpoint_url
         or v_connection.allowed_hosts is distinct from p_allowed_hosts
         or v_connection.auth_header_name is distinct from p_auth_header_name
         or v_connection.secret_ref is null then
        raise exception using errcode = '22023', message = 'capability_credential_preserve_invalid';
      end if;
      v_secret_ref := v_connection.secret_ref;
    else
      raise exception using errcode = '22023', message = 'capability_credential_preserve_invalid';
    end if;
  end if;

  if p_auth_type = 'none' then
    if p_auth_header_name is not null or p_secret_ref is not null
       or p_oauth_attempt_id is not null or p_preserve_credential then
      raise exception using errcode = '22023', message = 'capability_auth_fields_invalid';
    end if;
    v_secret_ref := null;
  elsif p_auth_type = 'oauth' then
    if p_auth_header_name is not null or p_secret_ref is not null then
      raise exception using errcode = '22023', message = 'capability_auth_fields_invalid';
    end if;
    if not p_preserve_credential then
      begin
        select s.decrypted_secret::jsonb into v_secret_bundle
        from vault.decrypted_secrets s
        where s.id = pg_catalog.replace(v_attempt.secret_ref, 'vault:', '')::uuid
        limit 1;
      exception when others then
        raise exception using errcode = 'P0001', message = 'oauth_secret_unavailable';
      end;
      if v_secret_bundle is null
         or coalesce(v_secret_bundle #>> '{tokens,access_token}', '') = ''
         or pg_catalog.lower(coalesce(v_secret_bundle #>> '{tokens,token_type}', '')) <> 'bearer' then
        raise exception using errcode = 'P0001', message = 'oauth_secret_unavailable';
      end if;
      begin
        v_token_expires_at := nullif(v_secret_bundle ->> 'tokenExpiresAt', '')::timestamptz;
      exception when others then
        raise exception using errcode = 'P0001', message = 'oauth_secret_unavailable';
      end;
    end if;
    v_secret_ref := null;
  elsif p_auth_type = 'bearer' then
    if p_auth_header_name is not null or p_oauth_attempt_id is not null
       or (not p_preserve_credential and v_secret_ref is null) then
      raise exception using errcode = '22023', message = 'capability_auth_fields_invalid';
    end if;
  elsif p_auth_type = 'header' then
    if p_auth_header_name is null or p_oauth_attempt_id is not null
       or (not p_preserve_credential and v_secret_ref is null) then
      raise exception using errcode = '22023', message = 'capability_auth_fields_invalid';
    end if;
  end if;

  v_material_change :=
    v_capability.provider is distinct from p_provider
    or v_current_digest is distinct from p_contract_digest
    or v_connection.endpoint_url is distinct from p_endpoint_url
    or v_connection.auth_type is distinct from p_auth_type
    or v_connection.auth_header_name is distinct from p_auth_header_name
    or v_connection.secret_ref is distinct from v_secret_ref
    or v_connection.allowed_hosts is distinct from p_allowed_hosts
    or (
      not p_preserve_credential
      and p_auth_type in ('oauth', 'bearer', 'header')
    );

  if v_material_change and exists (
    select 1
    from public.capability_bundle_items bi
    join public.capability_versions cv
      on cv.id = bi.capability_version_id
     and cv.workspace_id = bi.workspace_id
    join public.capability_bundle_versions bv
      on bv.id = bi.bundle_version_id
     and bv.workspace_id = bi.workspace_id
    join public.capability_bundles b
      on b.id = bv.bundle_id
     and b.workspace_id = bv.workspace_id
     and b.current_version_id = bv.id
    where cv.capability_id = p_capability_id
      and cv.workspace_id = p_workspace_id
  ) then
    raise exception using errcode = '55000', message = 'capability_provider_used_by_bundle';
  end if;

  select cv.id into v_version_id
  from public.capability_versions cv
  where cv.capability_id = p_capability_id
    and cv.workspace_id = p_workspace_id
    and cv.contract_digest = p_contract_digest
  limit 1;

  if v_version_id is null then
    insert into public.capability_versions (
      workspace_id, capability_id, version, environment, contract,
      contract_digest, change_summary, created_by
    )
    select p_workspace_id, p_capability_id,
      coalesce(pg_catalog.max(cv.version), 0) + 1,
      p_environment, p_contract, p_contract_digest,
      'Updated from Connections', p_user_id
    from public.capability_versions cv
    where cv.capability_id = p_capability_id
      and cv.workspace_id = p_workspace_id
    returning id into v_version_id;
  end if;

  if v_material_change then
    with revoked as (
      update public.capability_grants g
      set revoked_at = pg_catalog.now()
      where g.workspace_id = p_workspace_id
        and g.capability_id = p_capability_id
        and g.revoked_at is null
      returning 1
    )
    select pg_catalog.count(*)::integer into v_grants_revoked from revoked;
  end if;

  if not (p_auth_type = 'oauth' and p_preserve_credential) then
    delete from public.capability_oauth_credentials oc
    where oc.workspace_id = p_workspace_id
      and oc.connection_id = v_connection.id;
  end if;

  update public.capability_connections cc
  set endpoint_url = p_endpoint_url,
      auth_type = p_auth_type,
      auth_header_name = case when p_auth_type = 'header' then p_auth_header_name else null end,
      secret_ref = case when p_auth_type in ('bearer', 'header') then v_secret_ref else null end,
      allowed_hosts = p_allowed_hosts,
      timeout_ms = p_timeout_ms,
      enabled = true,
      updated_at = pg_catalog.now()
  where cc.id = v_connection.id
    and cc.workspace_id = p_workspace_id;
  if not found then
    raise exception using errcode = '40001', message = 'capability_connection_update_raced';
  end if;

  if p_auth_type = 'oauth' and not p_preserve_credential then
    insert into public.capability_oauth_credentials (
      workspace_id, connection_id, attempt_id, secret_ref, issuer, resource,
      scopes, token_expires_at, status
    ) values (
      p_workspace_id, v_connection.id, v_attempt.id, v_attempt.secret_ref,
      v_attempt.issuer, v_attempt.resource, v_attempt.scopes,
      v_token_expires_at, 'active'
    );

    update public.capability_oauth_attempts a
    set status = 'connected', consumed_at = pg_catalog.now(),
        capability_id = p_capability_id, error_code = null,
        updated_at = pg_catalog.now()
    where a.id = v_attempt.id
      and a.workspace_id = p_workspace_id
      and a.status = 'authorized';
    if not found then
      raise exception using errcode = '40001', message = 'oauth_attempt_raced';
    end if;
  end if;

  update public.capabilities c
  set provider = p_provider,
      title = p_title,
      description = p_description,
      provenance = p_provenance,
      current_version_id = v_version_id,
      status = case when v_material_change then 'draft' else c.status end,
      disabled_at = case when v_material_change then null else c.disabled_at end,
      updated_at = pg_catalog.now()
  where c.id = p_capability_id
    and c.workspace_id = p_workspace_id
    and c.deleted_at is null;
  if not found then
    raise exception using errcode = '40001', message = 'capability_provider_update_raced';
  end if;

  return query select
    p_capability_id, v_version_id, v_connection.id,
    v_grants_revoked, v_material_change;
end;
$function$;

revoke all on function public.update_capability_provider(uuid, uuid, uuid, timestamptz, text, text, text, jsonb, text, jsonb, text, text, text, text, text, text[], integer, boolean, uuid) from public, anon, authenticated;
grant execute on function public.update_capability_provider(uuid, uuid, uuid, timestamptz, text, text, text, jsonb, text, jsonb, text, text, text, text, text, text[], integer, boolean, uuid) to service_role;

CREATE OR REPLACE FUNCTION public.remove_capability_provider(p_workspace_id uuid, p_user_id uuid, p_capability_id uuid, p_expected_updated_at timestamp with time zone DEFAULT NULL::timestamp with time zone)
 RETURNS TABLE(capability_id uuid, grants_revoked integer, already_removed boolean)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_capability public.capabilities%rowtype;
  v_grants_revoked integer := 0;
begin
  if not exists (
    select 1
    from public.memberships m
    where m.workspace_id = p_workspace_id
      and m.user_id = p_user_id
      and m.role in ('owner', 'admin')
  ) then
    raise exception using errcode = '42501', message = 'capability_admin_required';
  end if;

  select c.* into v_capability
  from public.capabilities c
  where c.id = p_capability_id
    and c.workspace_id = p_workspace_id
  for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'capability_provider_not_found';
  end if;
  if v_capability.deleted_at is not null then
    return query select p_capability_id, 0, true;
    return;
  end if;
  if v_capability.type not in ('mcp_server', 'api', 'workflow') then
    raise exception using errcode = '22023', message = 'capability_provider_not_executable';
  end if;
  if p_expected_updated_at is not null
     and v_capability.updated_at is distinct from p_expected_updated_at then
    raise exception using errcode = '40001', message = 'capability_provider_stale';
  end if;

  if exists (
    select 1
    from public.capability_bundle_items bi
    join public.capability_versions cv
      on cv.id = bi.capability_version_id
     and cv.workspace_id = bi.workspace_id
    join public.capability_bundle_versions bv
      on bv.id = bi.bundle_version_id
     and bv.workspace_id = bi.workspace_id
    join public.capability_bundles b
      on b.id = bv.bundle_id
     and b.workspace_id = bv.workspace_id
     and b.current_version_id = bv.id
    where cv.capability_id = p_capability_id
      and cv.workspace_id = p_workspace_id
  ) then
    raise exception using errcode = '55000', message = 'capability_provider_used_by_bundle';
  end if;

  with revoked as (
    update public.capability_grants g
    set revoked_at = pg_catalog.now()
    where g.workspace_id = p_workspace_id
      and g.capability_id = p_capability_id
      and g.revoked_at is null
    returning 1
  )
  select pg_catalog.count(*)::integer into v_grants_revoked from revoked;

  -- Deleting the connection cascades its OAuth credential. The 0034 trigger
  -- removes the encrypted Vault bundle before the provider is tombstoned.
  delete from public.capability_connections cc
  where cc.workspace_id = p_workspace_id
    and cc.capability_id = p_capability_id;

  -- Connected attempts are historical plumbing, not invocation history. Once
  -- their credential is gone they can be removed and their shared Vault ref
  -- cleanup is harmlessly idempotent.
  delete from public.capability_oauth_attempts a
  where a.workspace_id = p_workspace_id
    and a.capability_id = p_capability_id;

  update public.capabilities c
  set status = 'disabled',
      disabled_at = pg_catalog.now(),
      deleted_at = pg_catalog.now(),
      updated_at = pg_catalog.now()
  where c.id = p_capability_id
    and c.workspace_id = p_workspace_id;
  if not found then
    raise exception using errcode = '40001', message = 'capability_provider_remove_raced';
  end if;

  return query select p_capability_id, v_grants_revoked, false;
end;
$function$;

revoke all on function public.remove_capability_provider(uuid, uuid, uuid, timestamptz) from public, anon, authenticated;
grant execute on function public.remove_capability_provider(uuid, uuid, uuid, timestamptz) to service_role;

-- ── 5. Triggers ───────────────────────────────────────────────────────────────

CREATE TRIGGER capability_principals_updated BEFORE UPDATE ON public.capability_principals FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
CREATE TRIGGER capabilities_protect_current_bundle BEFORE UPDATE OF status, current_version_id, disabled_at, deleted_at ON public.capabilities FOR EACH ROW EXECUTE FUNCTION public.protect_current_bundle_capability();
CREATE TRIGGER capabilities_updated BEFORE UPDATE ON public.capabilities FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
CREATE TRIGGER capability_connections_delete_secret AFTER DELETE ON public.capability_connections FOR EACH ROW EXECUTE FUNCTION public.delete_oauth_vault_secret_on_row_delete();
CREATE TRIGGER capability_connections_replace_secret AFTER UPDATE OF secret_ref ON public.capability_connections FOR EACH ROW WHEN (((old.secret_ref IS NOT NULL) AND (old.secret_ref IS DISTINCT FROM new.secret_ref))) EXECUTE FUNCTION public.delete_oauth_vault_secret_on_row_delete();
CREATE TRIGGER capability_connections_updated BEFORE UPDATE ON public.capability_connections FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
CREATE TRIGGER capability_bundles_updated BEFORE UPDATE ON public.capability_bundles FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
CREATE TRIGGER capability_bundles_validate_current_version BEFORE INSERT OR UPDATE ON public.capability_bundles FOR EACH ROW EXECUTE FUNCTION public.validate_capability_bundle_current_version();
CREATE TRIGGER capability_bundle_items_protect_current BEFORE INSERT OR DELETE OR UPDATE ON public.capability_bundle_items FOR EACH ROW EXECUTE FUNCTION public.protect_current_bundle_items();
CREATE TRIGGER capability_grants_validate_active_target BEFORE INSERT OR UPDATE OF capability_id, bundle_id, revoked_at ON public.capability_grants FOR EACH ROW EXECUTE FUNCTION public.validate_active_capability_grant();
CREATE TRIGGER capability_oauth_clients_delete_secret AFTER DELETE ON public.capability_oauth_clients FOR EACH ROW EXECUTE FUNCTION public.delete_oauth_vault_secret_on_row_delete();
CREATE TRIGGER capability_oauth_clients_replace_secret AFTER UPDATE OF secret_ref ON public.capability_oauth_clients FOR EACH ROW WHEN (((old.secret_ref IS NOT NULL) AND (old.secret_ref IS DISTINCT FROM new.secret_ref))) EXECUTE FUNCTION public.delete_oauth_vault_secret_on_row_delete();
CREATE TRIGGER capability_oauth_clients_updated BEFORE UPDATE ON public.capability_oauth_clients FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
CREATE TRIGGER capability_oauth_attempts_delete_secret AFTER DELETE ON public.capability_oauth_attempts FOR EACH ROW EXECUTE FUNCTION public.delete_oauth_vault_secret_on_row_delete();
CREATE TRIGGER capability_oauth_attempts_updated BEFORE UPDATE ON public.capability_oauth_attempts FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
CREATE TRIGGER capability_oauth_credentials_delete_secret AFTER DELETE ON public.capability_oauth_credentials FOR EACH ROW EXECUTE FUNCTION public.delete_oauth_vault_secret_on_row_delete();
CREATE TRIGGER capability_oauth_credentials_updated BEFORE UPDATE ON public.capability_oauth_credentials FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ── 6. Foreign keys ───────────────────────────────────────────────────────────

ALTER TABLE ONLY public.capability_principals
    ADD CONSTRAINT capability_principals_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.capabilities
    ADD CONSTRAINT capabilities_current_version_fk FOREIGN KEY (current_version_id, id, workspace_id) REFERENCES public.capability_versions(id, capability_id, workspace_id) ON DELETE RESTRICT;
ALTER TABLE ONLY public.capabilities
    ADD CONSTRAINT capabilities_owner_user_id_fkey FOREIGN KEY (owner_user_id) REFERENCES auth.users(id) ON DELETE SET NULL;
ALTER TABLE ONLY public.capabilities
    ADD CONSTRAINT capabilities_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.capability_versions
    ADD CONSTRAINT capability_versions_capability_id_workspace_id_fkey FOREIGN KEY (capability_id, workspace_id) REFERENCES public.capabilities(id, workspace_id) ON DELETE CASCADE;
ALTER TABLE ONLY public.capability_versions
    ADD CONSTRAINT capability_versions_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth.users(id) ON DELETE SET NULL;
ALTER TABLE ONLY public.capability_versions
    ADD CONSTRAINT capability_versions_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.capability_connections
    ADD CONSTRAINT capability_connections_capability_id_workspace_id_fkey FOREIGN KEY (capability_id, workspace_id) REFERENCES public.capabilities(id, workspace_id) ON DELETE CASCADE;
ALTER TABLE ONLY public.capability_connections
    ADD CONSTRAINT capability_connections_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.capability_bundles
    ADD CONSTRAINT capability_bundles_current_version_fk FOREIGN KEY (current_version_id, id, workspace_id) REFERENCES public.capability_bundle_versions(id, bundle_id, workspace_id) ON DELETE RESTRICT;
ALTER TABLE ONLY public.capability_bundles
    ADD CONSTRAINT capability_bundles_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.capability_bundle_versions
    ADD CONSTRAINT capability_bundle_versions_bundle_id_workspace_id_fkey FOREIGN KEY (bundle_id, workspace_id) REFERENCES public.capability_bundles(id, workspace_id) ON DELETE CASCADE;
ALTER TABLE ONLY public.capability_bundle_versions
    ADD CONSTRAINT capability_bundle_versions_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth.users(id) ON DELETE SET NULL;
ALTER TABLE ONLY public.capability_bundle_versions
    ADD CONSTRAINT capability_bundle_versions_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.capability_bundle_items
    ADD CONSTRAINT capability_bundle_items_bundle_version_id_workspace_id_fkey FOREIGN KEY (bundle_version_id, workspace_id) REFERENCES public.capability_bundle_versions(id, workspace_id) ON DELETE CASCADE;
ALTER TABLE ONLY public.capability_bundle_items
    ADD CONSTRAINT capability_bundle_items_capability_version_id_workspace_id_fkey FOREIGN KEY (capability_version_id, workspace_id) REFERENCES public.capability_versions(id, workspace_id) ON DELETE RESTRICT;
ALTER TABLE ONLY public.capability_bundle_items
    ADD CONSTRAINT capability_bundle_items_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.capability_grants
    ADD CONSTRAINT capability_grants_bundle_id_workspace_id_fkey FOREIGN KEY (bundle_id, workspace_id) REFERENCES public.capability_bundles(id, workspace_id) ON DELETE CASCADE;
ALTER TABLE ONLY public.capability_grants
    ADD CONSTRAINT capability_grants_capability_id_workspace_id_fkey FOREIGN KEY (capability_id, workspace_id) REFERENCES public.capabilities(id, workspace_id) ON DELETE CASCADE;
ALTER TABLE ONLY public.capability_grants
    ADD CONSTRAINT capability_grants_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth.users(id) ON DELETE SET NULL;
ALTER TABLE ONLY public.capability_grants
    ADD CONSTRAINT capability_grants_principal_id_workspace_id_fkey FOREIGN KEY (principal_id, workspace_id) REFERENCES public.capability_principals(id, workspace_id) ON DELETE CASCADE;
ALTER TABLE ONLY public.capability_grants
    ADD CONSTRAINT capability_grants_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.capability_invocations
    ADD CONSTRAINT capability_invocations_capability_id_workspace_id_fkey FOREIGN KEY (capability_id, workspace_id) REFERENCES public.capabilities(id, workspace_id) ON DELETE CASCADE;
ALTER TABLE ONLY public.capability_invocations
    ADD CONSTRAINT capability_invocations_capability_version_id_capability_id_fkey FOREIGN KEY (capability_version_id, capability_id, workspace_id) REFERENCES public.capability_versions(id, capability_id, workspace_id) ON DELETE RESTRICT;
ALTER TABLE ONLY public.capability_invocations
    ADD CONSTRAINT capability_invocations_node_id_fkey FOREIGN KEY (node_id) REFERENCES public.nodes(id) ON DELETE SET NULL;
ALTER TABLE ONLY public.capability_invocations
    ADD CONSTRAINT capability_invocations_principal_id_workspace_id_fkey FOREIGN KEY (principal_id, workspace_id) REFERENCES public.capability_principals(id, workspace_id) ON DELETE RESTRICT;
ALTER TABLE ONLY public.capability_invocations
    ADD CONSTRAINT capability_invocations_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.capability_rate_buckets
    ADD CONSTRAINT capability_rate_buckets_capability_id_workspace_id_fkey FOREIGN KEY (capability_id, workspace_id) REFERENCES public.capabilities(id, workspace_id) ON DELETE CASCADE;
ALTER TABLE ONLY public.capability_rate_buckets
    ADD CONSTRAINT capability_rate_buckets_principal_id_workspace_id_fkey FOREIGN KEY (principal_id, workspace_id) REFERENCES public.capability_principals(id, workspace_id) ON DELETE CASCADE;
ALTER TABLE ONLY public.capability_rate_buckets
    ADD CONSTRAINT capability_rate_buckets_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.capability_runtime_state
    ADD CONSTRAINT capability_runtime_state_capability_id_workspace_id_fkey FOREIGN KEY (capability_id, workspace_id) REFERENCES public.capabilities(id, workspace_id) ON DELETE CASCADE;
ALTER TABLE ONLY public.capability_runtime_state
    ADD CONSTRAINT capability_runtime_state_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.capability_reviews
    ADD CONSTRAINT capability_reviews_capability_id_workspace_id_fkey FOREIGN KEY (capability_id, workspace_id) REFERENCES public.capabilities(id, workspace_id) ON DELETE CASCADE;
ALTER TABLE ONLY public.capability_reviews
    ADD CONSTRAINT capability_reviews_reviewer_user_id_fkey FOREIGN KEY (reviewer_user_id) REFERENCES auth.users(id) ON DELETE SET NULL;
ALTER TABLE ONLY public.capability_reviews
    ADD CONSTRAINT capability_reviews_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.capability_oauth_clients
    ADD CONSTRAINT capability_oauth_clients_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.capability_oauth_attempts
    ADD CONSTRAINT capability_oauth_attempts_capability_id_workspace_id_fkey FOREIGN KEY (capability_id, workspace_id) REFERENCES public.capabilities(id, workspace_id) ON DELETE CASCADE;
ALTER TABLE ONLY public.capability_oauth_attempts
    ADD CONSTRAINT capability_oauth_attempts_requested_by_fkey FOREIGN KEY (requested_by) REFERENCES auth.users(id) ON DELETE SET NULL;
ALTER TABLE ONLY public.capability_oauth_attempts
    ADD CONSTRAINT capability_oauth_attempts_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.capability_oauth_credentials
    ADD CONSTRAINT capability_oauth_credentials_attempt_id_workspace_id_fkey FOREIGN KEY (attempt_id, workspace_id) REFERENCES public.capability_oauth_attempts(id, workspace_id);
ALTER TABLE ONLY public.capability_oauth_credentials
    ADD CONSTRAINT capability_oauth_credentials_connection_id_workspace_id_fkey FOREIGN KEY (connection_id, workspace_id) REFERENCES public.capability_connections(id, workspace_id) ON DELETE CASCADE;
ALTER TABLE ONLY public.capability_oauth_credentials
    ADD CONSTRAINT capability_oauth_credentials_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;

-- ── 7. Row level security ─────────────────────────────────────────────────────

-- RLS is not the authorisation layer (the API checks the caller's role and
-- grant first and writes with the service role); these are the policies the
-- tables had, kept so a request-scoped client still sees only its own
-- workspace. The OAuth tables, rate buckets and runtime state have RLS on
-- and no policy: service role only.
ALTER TABLE public.capability_principals ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.capabilities ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.capability_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.capability_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.capability_bundles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.capability_bundle_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.capability_bundle_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.capability_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.capability_invocations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.capability_rate_buckets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.capability_runtime_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.capability_reviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.capability_oauth_clients ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.capability_oauth_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.capability_oauth_credentials ENABLE ROW LEVEL SECURITY;
CREATE POLICY capability_principals_admin_all ON public.capability_principals USING (public.is_workspace_admin(workspace_id)) WITH CHECK (public.is_workspace_admin(workspace_id));
CREATE POLICY capabilities_admin_write ON public.capabilities USING (public.is_workspace_admin(workspace_id)) WITH CHECK (public.is_workspace_admin(workspace_id));
CREATE POLICY capabilities_member_read ON public.capabilities FOR SELECT USING (public.is_workspace_member(workspace_id));
CREATE POLICY capability_versions_admin_insert ON public.capability_versions FOR INSERT WITH CHECK (public.is_workspace_admin(workspace_id));
CREATE POLICY capability_versions_member_read ON public.capability_versions FOR SELECT USING (public.is_workspace_member(workspace_id));
CREATE POLICY capability_connections_admin_all ON public.capability_connections USING (public.is_workspace_admin(workspace_id)) WITH CHECK (public.is_workspace_admin(workspace_id));
CREATE POLICY capability_bundles_admin_write ON public.capability_bundles USING (public.is_workspace_admin(workspace_id)) WITH CHECK (public.is_workspace_admin(workspace_id));
CREATE POLICY capability_bundles_member_read ON public.capability_bundles FOR SELECT USING (public.is_workspace_member(workspace_id));
CREATE POLICY capability_bundle_versions_admin_insert ON public.capability_bundle_versions FOR INSERT WITH CHECK (public.is_workspace_admin(workspace_id));
CREATE POLICY capability_bundle_versions_member_read ON public.capability_bundle_versions FOR SELECT USING (public.is_workspace_member(workspace_id));
CREATE POLICY capability_bundle_items_admin_insert ON public.capability_bundle_items FOR INSERT WITH CHECK ((EXISTS ( SELECT 1
   FROM public.capability_bundle_versions bv
  WHERE ((bv.id = capability_bundle_items.bundle_version_id) AND public.is_workspace_admin(bv.workspace_id)))));
CREATE POLICY capability_bundle_items_member_read ON public.capability_bundle_items FOR SELECT USING ((EXISTS ( SELECT 1
   FROM public.capability_bundle_versions bv
  WHERE ((bv.id = capability_bundle_items.bundle_version_id) AND public.is_workspace_member(bv.workspace_id)))));
CREATE POLICY capability_grants_admin_all ON public.capability_grants USING (public.is_workspace_admin(workspace_id)) WITH CHECK (public.is_workspace_admin(workspace_id));
CREATE POLICY capability_invocations_member_read ON public.capability_invocations FOR SELECT USING (public.is_workspace_member(workspace_id));
CREATE POLICY capability_reviews_admin_insert ON public.capability_reviews FOR INSERT WITH CHECK (public.is_workspace_admin(workspace_id));
CREATE POLICY capability_reviews_member_read ON public.capability_reviews FOR SELECT USING (public.is_workspace_member(workspace_id));

-- ── 8. Table privileges ───────────────────────────────────────────────────────

-- Stated explicitly instead of left to the default privileges, so the
-- result is the same on every database: the three OAuth tables hold Vault
-- references and are service-role only, as in 0034.
revoke all on table public.capability_principals, public.capabilities, public.capability_versions, public.capability_connections, public.capability_bundles, public.capability_bundle_versions, public.capability_bundle_items, public.capability_grants, public.capability_invocations, public.capability_rate_buckets, public.capability_runtime_state, public.capability_reviews, public.capability_oauth_clients, public.capability_oauth_attempts, public.capability_oauth_credentials from public, anon, authenticated;
GRANT ALL ON TABLE public.capability_principals TO anon;
GRANT ALL ON TABLE public.capability_principals TO authenticated;
GRANT ALL ON TABLE public.capability_principals TO service_role;
GRANT ALL ON TABLE public.capabilities TO anon;
GRANT ALL ON TABLE public.capabilities TO authenticated;
GRANT ALL ON TABLE public.capabilities TO service_role;
GRANT ALL ON TABLE public.capability_versions TO anon;
GRANT ALL ON TABLE public.capability_versions TO authenticated;
GRANT ALL ON TABLE public.capability_versions TO service_role;
GRANT ALL ON TABLE public.capability_connections TO anon;
GRANT ALL ON TABLE public.capability_connections TO authenticated;
GRANT ALL ON TABLE public.capability_connections TO service_role;
GRANT ALL ON TABLE public.capability_bundles TO anon;
GRANT ALL ON TABLE public.capability_bundles TO authenticated;
GRANT ALL ON TABLE public.capability_bundles TO service_role;
GRANT ALL ON TABLE public.capability_bundle_versions TO anon;
GRANT ALL ON TABLE public.capability_bundle_versions TO authenticated;
GRANT ALL ON TABLE public.capability_bundle_versions TO service_role;
GRANT ALL ON TABLE public.capability_bundle_items TO anon;
GRANT ALL ON TABLE public.capability_bundle_items TO authenticated;
GRANT ALL ON TABLE public.capability_bundle_items TO service_role;
GRANT ALL ON TABLE public.capability_grants TO anon;
GRANT ALL ON TABLE public.capability_grants TO authenticated;
GRANT ALL ON TABLE public.capability_grants TO service_role;
GRANT ALL ON TABLE public.capability_invocations TO anon;
GRANT ALL ON TABLE public.capability_invocations TO authenticated;
GRANT ALL ON TABLE public.capability_invocations TO service_role;
GRANT ALL ON TABLE public.capability_rate_buckets TO anon;
GRANT ALL ON TABLE public.capability_rate_buckets TO authenticated;
GRANT ALL ON TABLE public.capability_rate_buckets TO service_role;
GRANT ALL ON TABLE public.capability_runtime_state TO anon;
GRANT ALL ON TABLE public.capability_runtime_state TO authenticated;
GRANT ALL ON TABLE public.capability_runtime_state TO service_role;
GRANT ALL ON TABLE public.capability_reviews TO anon;
GRANT ALL ON TABLE public.capability_reviews TO authenticated;
GRANT ALL ON TABLE public.capability_reviews TO service_role;
GRANT ALL ON TABLE public.capability_oauth_clients TO service_role;
GRANT ALL ON TABLE public.capability_oauth_attempts TO service_role;
GRANT ALL ON TABLE public.capability_oauth_credentials TO service_role;

-- ── 9. The agent connection policy, with capability grants again ─────────
-- 0099 replaced the 8-argument RPC with a 5-argument one without grants.
-- Drop that one so PostgREST resolves exactly one function by name, and
-- recreate the original with `credentials:use` among the scopes.
drop function if exists public.update_agent_connection_policy(uuid, uuid, uuid, text, text[]);

CREATE OR REPLACE FUNCTION public.update_agent_connection_policy(p_workspace_id uuid, p_user_id uuid, p_agent_id uuid, p_display_name text, p_role text, p_scopes text[], p_capability_ids uuid[], p_bundle_ids uuid[])
 RETURNS TABLE(principal_id uuid, grants_written integer, effective_scopes text[])
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_id uuid;
  v_principal_id uuid;
  v_written integer := 0;
  v_effective_scopes text[] := '{}'::text[];
begin
  if not exists (
    select 1 from public.memberships m
    where m.workspace_id = p_workspace_id
      and m.user_id = p_user_id
      and m.role in ('owner', 'admin')
  ) then
    raise exception using errcode = '42501', message = 'capability_admin_required';
  end if;
  if p_role not in ('observer', 'collaborator', 'operator', 'custom')
     or p_scopes is null
     or pg_catalog.cardinality(p_scopes) not between 1 and 8
     or pg_catalog.array_position(p_scopes, null) is not null
     or not (p_scopes <@ array[
       'nodes:read','nodes:write','chat:run','skills:execute',
       'agents:read','agents:write','credentials:use','admin:*'
     ]::text[])
     or p_display_name is null
     or pg_catalog.char_length(p_display_name) not between 1 and 200
     or pg_catalog.cardinality(coalesce(p_capability_ids, '{}'::uuid[])) > 100
     or pg_catalog.cardinality(coalesce(p_bundle_ids, '{}'::uuid[])) > 100 then
    raise exception using errcode = '22023', message = 'capability_grant_input_invalid';
  end if;

  perform awa.agent_id
  from public.agent_workspace_access awa
  join public.agents a on a.id = awa.agent_id
  where awa.agent_id = p_agent_id
    and awa.workspace_id = p_workspace_id
    and awa.revoked_at is null
    and a.status = 'active'
  for update of awa, a;
  if not found then
    raise exception using errcode = 'P0002', message = 'agent_connection_not_found';
  end if;

  insert into public.capability_principals (
    workspace_id, kind, source_type, source_id, display_name, disabled_at
  ) values (
    p_workspace_id, 'agent', 'agent', p_agent_id::text, p_display_name, null
  )
  on conflict (workspace_id, source_type, source_id) do update
  set kind = 'agent', display_name = excluded.display_name,
      disabled_at = null, updated_at = pg_catalog.now()
  returning id into v_principal_id;

  for v_id in
    select distinct value
    from pg_catalog.unnest(coalesce(p_capability_ids, '{}'::uuid[])) value
    order by value
  loop
    perform c.id
    from public.capabilities c
    where c.id = v_id
      and c.workspace_id = p_workspace_id
      and c.status = 'approved'
      and c.disabled_at is null
      and c.deleted_at is null
    for share;
    if not found then
      raise exception using errcode = '23514', message = 'capability_grant_target_unavailable';
    end if;
  end loop;

  for v_id in
    select distinct value
    from pg_catalog.unnest(coalesce(p_bundle_ids, '{}'::uuid[])) value
    order by value
  loop
    perform b.id
    from public.capability_bundles b
    where b.id = v_id
      and b.workspace_id = p_workspace_id
      and b.status = 'approved'
      and b.current_version_id is not null
    for share;
    if not found then
      raise exception using errcode = '23514', message = 'capability_grant_target_unavailable';
    end if;
  end loop;

  update public.capability_grants g
  set revoked_at = pg_catalog.now()
  where g.workspace_id = p_workspace_id
    and g.principal_id = v_principal_id
    and g.revoked_at is null;

  insert into public.capability_grants (
    workspace_id, principal_id, capability_id, bundle_id,
    actions, constraints, created_by
  )
  select p_workspace_id, v_principal_id, value, null,
         array['discover','invoke']::text[], '{}'::jsonb, p_user_id
  from (
    select distinct value
    from pg_catalog.unnest(coalesce(p_capability_ids, '{}'::uuid[])) value
  ) direct_grants
  union all
  select p_workspace_id, v_principal_id, null, value,
         array['discover','invoke']::text[], '{}'::jsonb, p_user_id
  from (
    select distinct value
    from pg_catalog.unnest(coalesce(p_bundle_ids, '{}'::uuid[])) value
  ) bundle_grants;
  get diagnostics v_written = row_count;

  update public.agent_workspace_access awa
  set role = p_role, scopes = p_scopes
  where awa.agent_id = p_agent_id
    and awa.workspace_id = p_workspace_id
    and awa.revoked_at is null;
  if not found then
    raise exception using errcode = '40001', message = 'agent_connection_update_raced';
  end if;

  select coalesce(pg_catalog.array_agg(allowed.scope order by allowed.ordinality), '{}'::text[])
    into v_effective_scopes
  from pg_catalog.unnest(array[
    'nodes:read','nodes:write','chat:run','skills:execute',
    'agents:read','agents:write','credentials:use','admin:*'
  ]::text[]) with ordinality as allowed(scope, ordinality)
  where not exists (
    select 1
    from public.agent_workspace_access policy
    where policy.agent_id = p_agent_id
      and policy.revoked_at is null
      and not (allowed.scope = any(policy.scopes))
  );

  update public.api_tokens
  set scopes = v_effective_scopes
  where agent_id = p_agent_id and revoked_at is null;
  update public.oauth_access_tokens
  set scopes = v_effective_scopes
  where agent_id = p_agent_id and revoked_at is null;
  update public.user_api_tokens
  set scopes = v_effective_scopes
  where agent_id = p_agent_id and revoked_at is null;

  return query select v_principal_id, v_written, v_effective_scopes;
end;
$function$;

revoke all on function public.update_agent_connection_policy(uuid, uuid, uuid, text, text, text[], uuid[], uuid[]) from public, anon, authenticated;
grant execute on function public.update_agent_connection_policy(uuid, uuid, uuid, text, text, text[], uuid[], uuid[]) to service_role;

-- ── 10. Principals for agents connected while the gateway was gone ────────
-- A grant points at a capability principal, and the API creates one when an
-- agent is connected (lib/agents/connections.server.ts). Connections made
-- between 0099 and this migration have none; give every live one its row so
-- the Agents page can grant it providers without a reconnect. Upsert, so a
-- principal restored from old data keeps its id and is only re-enabled.
insert into public.capability_principals (
  workspace_id, kind, source_type, source_id, display_name
)
select awa.workspace_id, 'agent', 'agent', a.id::text, left(a.name, 200)
from public.agent_workspace_access awa
join public.agents a on a.id = awa.agent_id
where awa.revoked_at is null
  and a.status = 'active'
on conflict (workspace_id, source_type, source_id) do nothing;

commit;
