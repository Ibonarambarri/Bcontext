/**
 * The business layer's vocabularies that exist twice: once in the contract,
 * once in 0103 (or a later migration). Same failure, same cure as
 * `auth/scopes-vocabulary-matches-db.test.ts`: a CHECK or a trigger only bites
 * on write, so a kind added to `NODE_KINDS` and not to `nodes_kind_guard`
 * would make every create of that kind a 500 in production and nowhere else.
 *
 * Reads the migrations as text; the newest definition wins.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { NODE_KINDS } from "@bcontext-dev/contract/types";
import { BUSINESS_MODELS } from "@bcontext-dev/contract/business/record-types";
import { VIEW_RENDERERS, ViewPresentationSchema, ViewQuerySchema } from "@bcontext-dev/contract/views/schema";

const MIGRATIONS = join(process.cwd(), "supabase", "migrations");

function migrations(): Array<{ file: string; sql: string }> {
  return readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((file) => ({ file, sql: readFileSync(join(MIGRATIONS, file), "utf8") }));
}

/** Literals of the last match of `pattern` across every migration. */
function latest(pattern: RegExp): string[] | null {
  let found: string[] | null = null;
  for (const { sql } of migrations()) {
    for (const match of sql.matchAll(pattern)) {
      found = [...(match[1] ?? "").matchAll(/'([^']+)'/g)].map((m) => m[1] as string);
    }
  }
  return found;
}

describe("business vocabularies match the database", () => {
  it("nodes_kind_guard lists exactly NODE_KINDS", () => {
    const literals = latest(/function public\.nodes_kind_guard\(\)[\s\S]*?new\.kind = any \(array\[([^\]]*)\]\)/gi);
    expect(literals).toEqual([...NODE_KINDS]);
  });

  it("record type keys may not be core kinds — the same list", () => {
    const literals = latest(/constraint record_types_key_not_core check \(\s*key <> all \(array\[([^\]]*)\]\)/gi);
    expect(literals).toEqual([...NODE_KINDS]);
  });

  // The API stores the normalised query and presentation, so every key the
  // contract's schemas fill in must be one the CHECK allows (0104: a template
  // applied on Postgres skipped every view because these lists lagged).
  it("saved_views_query_keys allows every key of a normalised view query", () => {
    const allowed = latest(/add constraint saved_views_query_keys check \(\s*\(query - array\[([^\]]*)\]\)/gi);
    const keys = Object.keys(ViewQuerySchema.parse({ schema_version: 1 }));
    expect(keys.filter((key) => !allowed?.includes(key))).toEqual([]);
  });

  it("saved_views_presentation_keys allows every renderer and presentation key", () => {
    const renderers = latest(/add constraint saved_views_presentation_keys check \([\s\S]*?\(presentation ->> 'renderer'\) = any \(array\[([^\]]*)\]\)/gi);
    expect(VIEW_RENDERERS.filter((renderer) => !renderers?.includes(renderer))).toEqual([]);
    const allowed = latest(/add constraint saved_views_presentation_keys check \([\s\S]*?\(presentation - array\[([^\]]*)\]\)/gi);
    const keys = Object.keys(ViewPresentationSchema.parse({ schema_version: 1, renderer: "table" }));
    expect(keys.filter((key) => !allowed?.includes(key))).toEqual([]);
  });

  it("workspaces_business_model_check lists exactly BUSINESS_MODELS", () => {
    const literals = latest(/add constraint workspaces_business_model_check\s+check \(business_model in \(([^)]*)\)\)/gi);
    expect(literals).toEqual([...BUSINESS_MODELS]);
  });
});
