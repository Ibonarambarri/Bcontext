/**
 * The business settings live on the workspace row (0103) and are read from
 * the storage's bound workspace. On Supabase that row goes through
 * `rowToWorkspace`, which used to keep only the core columns, so every
 * workspace read as `product` whatever PATCH /business had saved: no KPI
 * set, the knowledge dashboard instead of the business one. This pins the
 * path from a `select *` row to `getBusinessSettings`.
 */
import { describe, expect, it } from "vitest";
import { rowToWorkspace } from "@/lib/storage/supabase";
import { getBusinessSettings } from "./record-types";

const row = {
  id: "8d6c3c56-0000-4000-8000-000000000001",
  slug: "acme",
  name: "Acme",
  description: null,
  github_repo: null,
  metadata: {},
  created_at: "2026-11-12T00:00:00Z",
};

describe("business settings on a Supabase workspace row", () => {
  it("reads the saved model and currency", async () => {
    const workspace = rowToWorkspace({ ...row, business_model: "marketplace", business_currency: "USD" });
    expect(await getBusinessSettings({ backend: "supabase", workspace } as never)).toEqual({ business_model: "marketplace", currency: "USD" });
  });

  it("falls back to product / EUR for a row without them", async () => {
    expect(await getBusinessSettings({ backend: "supabase", workspace: rowToWorkspace(row) } as never)).toEqual({ business_model: "product", currency: "EUR" });
  });
});
