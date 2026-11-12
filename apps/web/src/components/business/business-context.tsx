"use client";

/**
 * The workspace's business settings (model and reporting currency), for the
 * client components of the shell that need them: the sidebar's Business
 * section, above all.
 *
 * Mounted by `workspace-shell.tsx` with what the layout read through
 * `@/web/business`, plus the sides the workspace renamed (`side_names`, from
 * its record types) so the sidebar, the view header and the heatmap say
 * "Instructors" where a template said "Suppliers"; it is a separate, tiny context rather than a field of
 * `useWorkspace()` so the business layer can move without touching the
 * workspace context every view depends on.
 *
 * Must not break: outside a provider (a test, a page rendered without the
 * shell) the answer is a `product` workspace, which shows nothing extra.
 */
import { createContext, useContext } from "react";
import type { BusinessSettings } from "@bcontext-dev/contract/business/record-types";
import type { SideNames } from "@bcontext-dev/contract/business/names";

export type BusinessShellValue = BusinessSettings & { side_names?: SideNames };

const PRODUCT: BusinessShellValue = { business_model: "product", currency: "EUR", side_names: {} };

const BusinessContext = createContext<BusinessShellValue>(PRODUCT);

export function BusinessProvider({ value, children }: { value: BusinessShellValue | null | undefined; children: React.ReactNode }) {
  return <BusinessContext.Provider value={value ?? PRODUCT}>{children}</BusinessContext.Provider>;
}

export function useBusiness(): BusinessShellValue {
  return useContext(BusinessContext);
}

/** The workspace's renamed sides; `{}` when it renamed none (or is a product workspace). */
export function useSideNames(): SideNames {
  return useContext(BusinessContext).side_names ?? {};
}
