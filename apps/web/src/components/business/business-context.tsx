"use client";

/**
 * The workspace's business settings (model and reporting currency), for the
 * client components of the shell that need them: the sidebar's Business
 * section, above all.
 *
 * Mounted by `workspace-shell.tsx` with what the layout read through
 * `@/web/business`; it is a separate, tiny context rather than a field of
 * `useWorkspace()` so the business layer can move without touching the
 * workspace context every view depends on.
 *
 * Must not break: outside a provider (a test, a page rendered without the
 * shell) the answer is a `product` workspace, which shows nothing extra.
 */
import { createContext, useContext } from "react";
import type { BusinessSettings } from "@bcontext-dev/contract/business/record-types";

const PRODUCT: BusinessSettings = { business_model: "product", currency: "EUR" };

const BusinessContext = createContext<BusinessSettings>(PRODUCT);

export function BusinessProvider({ value, children }: { value: BusinessSettings | null | undefined; children: React.ReactNode }) {
  return <BusinessContext.Provider value={value ?? PRODUCT}>{children}</BusinessContext.Provider>;
}

export function useBusiness(): BusinessSettings {
  return useContext(BusinessContext);
}
