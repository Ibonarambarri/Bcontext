-- 0104_record_views.sql
-- Saved views over record types (v0.4.0): the view query gained
-- `field_filters` and `dataset_type`, and the presentation the `metrics` and
-- `heatmap` renderers. The API writes the normalised query, so every view
-- insert carries both new keys; the CHECKs from 0090 rejected all of them,
-- and a business template applied on Postgres created its record types but
-- none of its views (Pipeline, Accounts, Metrics…), each skipped with
-- "violates check constraint". The demo backend has no CHECKs, which is why
-- the tests did not see it.
--
-- Same cure as 0090's: re-declare both CHECKs with the contract's keys.
-- `timeline` stays allowed for stored custom views the contract coerces on
-- read. `vocabulary-matches-db.test.ts` now fails when the contract's query
-- keys or renderers drift from these lists. Idempotent.
begin;

alter table public.saved_views drop constraint if exists saved_views_presentation_keys;
alter table public.saved_views add constraint saved_views_presentation_keys check (
  (presentation ? 'renderer')
  and ((presentation ->> 'renderer') = any (array['graph','board','timeline','table','list','changes','browse','credentials','roadmap','metrics','heatmap']))
  and ((presentation - array['schema_version','renderer','group_by','sort_by','columns','clustering','layout']) = '{}'::jsonb)
);

alter table public.saved_views drop constraint if exists saved_views_query_keys;
alter table public.saved_views add constraint saved_views_query_keys check (
  (query - array['schema_version','kinds','tags_any','tags_all','statuses','dates','source','actor','root_node_ids','traversal','unblocked','field_filters','dataset_type']) = '{}'::jsonb
);

commit;
