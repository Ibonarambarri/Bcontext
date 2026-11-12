/**
 * The four business models as a person picks them: a name and one line each.
 *
 * Who uses it: the business model picker (new workspace dialog and the
 * workspace panel's Business section). The values are the contract's
 * `BUSINESS_MODELS`; `models.test.ts` fails if one is missing here.
 *
 * Order matters: the default (`product`) is last on screen because the
 * three business ones are the reason the question is asked at all, but it
 * is preselected — most workspaces are a team building software.
 */
import type { BusinessModel } from "@bcontext-dev/contract/business/record-types";

export interface BusinessModelOption {
  id: BusinessModel;
  label: string;
  line: string;
}

export const BUSINESS_MODEL_OPTIONS: readonly BusinessModelOption[] = [
  { id: "b2b", label: "B2B", line: "You sell subscriptions to companies: accounts, pipeline, MRR and renewals." },
  { id: "b2c", label: "B2C", line: "You sell subscriptions to people: customers, MRR and churn, no sales pipeline." },
  { id: "marketplace", label: "Marketplace", line: "You match suppliers and buyers: GMV, take rate, bookings and liquidity." },
  { id: "product", label: "Just product / team", line: "A team building software. Knowledge, tasks and decisions; no business metrics." },
];

export const DEFAULT_BUSINESS_MODEL: BusinessModel = "product";

export function businessModelLabel(model: BusinessModel): string {
  return BUSINESS_MODEL_OPTIONS.find((option) => option.id === model)?.label ?? model;
}
