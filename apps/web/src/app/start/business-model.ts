/**
 * The business model question of `/start`, outside the `"use server"` file
 * (which may only export actions): reading it from the submitted form, and
 * keeping it in this browser while the person confirms their email.
 *
 * Who uses it: `actions.ts` (both actions read the field) and
 * `start-form.tsx` (the radio group and the remembered choice). Must not
 * break: anything that is not one of the contract's `BUSINESS_MODELS` reads
 * as `product` — the default every workspace had before the question.
 */
import { isBusinessModel, type BusinessModel } from "@bcontext-dev/contract/business/record-types";

export const START_DEFAULT_MODEL: BusinessModel = "product";

/** The model the form chose; anything else (an old form, a tampered one) is product. */
export function businessModelFrom(formData: FormData): BusinessModel {
  const raw = formData.get("business_model");
  return isBusinessModel(raw) ? raw : START_DEFAULT_MODEL;
}

/** A stored value read back; unknown → product. */
export function parseStoredModel(raw: string | null | undefined): BusinessModel {
  return isBusinessModel(raw) ? raw : START_DEFAULT_MODEL;
}
