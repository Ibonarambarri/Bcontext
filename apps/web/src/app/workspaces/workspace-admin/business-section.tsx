"use client";

/**
 * The workspace's business: which model it runs (it decides the dashboard,
 * the KPIs and the Business section of the sidebar), the currency its
 * metrics are reported in, and the model's template applied on demand.
 * Rendered by `workspace-admin-modal.tsx`; reads and writes
 * `/api/workspaces/<slug>/business` (+ `/apply-template`) through
 * `@/lib/business/client`.
 *
 * The template is additive and says so: applying it adds the record types,
 * fields and views the model expects and keeps everything already there, so
 * it is safe to press twice and safe after a person has customised things.
 *
 * Must not break: someone who does not manage the workspace sees the model
 * and currency, not a form the API would refuse.
 */
import { useEffect, useState } from "react";
import { Alert, Button, Description, Input, Label, Skeleton, TextField } from "@heroui/react";
import type { BusinessModel, BusinessSettings } from "@bcontext-dev/contract/business/record-types";
import { BusinessModelPicker } from "@/components/business/business-model-picker";
import { applyBusinessTemplate, fetchBusinessSettings, patchBusinessSettings } from "@/lib/business/client";
import { businessModelLabel } from "@/lib/business/models";
import { Block, SectionHead, type PanelSection } from "./panel-ui";

const HINT = "What kind of business this workspace runs. It decides the dashboard, the KPIs and the record types agents fill in.";

export function BusinessSection({
  slug,
  canManage,
  onGo,
}: {
  slug: string;
  canManage: boolean;
  onGo: (section: PanelSection) => void;
}) {
  const [saved, setSaved] = useState<BusinessSettings | null>(null);
  const [model, setModel] = useState<BusinessModel>("product");
  const [currency, setCurrency] = useState("EUR");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [pending, setPending] = useState<"save" | "template" | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchBusinessSettings(slug)
      .then((settings) => {
        if (cancelled) return;
        const value = settings ?? { business_model: "product" as const, currency: "EUR" };
        setSaved(value);
        setModel(value.business_model);
        setCurrency(value.currency);
      })
      .catch((err: unknown) => {
        if (!cancelled) setLoadError(err instanceof Error ? err.message : "Couldn't load the business settings.");
      });
    return () => {
      cancelled = true;
    };
  }, [slug]);

  const code = currency.trim().toUpperCase();
  const currencyValid = /^[A-Z]{3}$/.test(code);
  const dirty = saved !== null && (model !== saved.business_model || code !== saved.currency);

  async function save() {
    if (!dirty || !currencyValid || pending) return;
    setPending("save");
    setError(null);
    setNote(null);
    try {
      const next = await patchBusinessSettings(slug, {
        ...(model !== saved?.business_model ? { business_model: model } : {}),
        ...(code !== saved?.currency ? { currency: code } : {}),
      });
      setSaved(next ?? { business_model: model, currency: code });
      setNote(model !== saved?.business_model && model !== "product"
        ? "Saved. Apply the template below to add this model's record types and views."
        : "Saved. Reload the workspace to see the new dashboard.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't save.");
    } finally {
      setPending(null);
    }
  }

  async function applyTemplate() {
    if (!saved || saved.business_model === "product" || pending) return;
    setPending("template");
    setError(null);
    setNote(null);
    try {
      await applyBusinessTemplate(slug, saved.business_model);
      setNote(`The ${businessModelLabel(saved.business_model)} template is applied. Nothing that was already here changed.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't apply the template.");
    } finally {
      setPending(null);
    }
  }

  if (loadError) {
    return (
      <div>
        <SectionHead title="Business" hint={HINT} />
        <p role="alert" className="text-[13px] text-danger">{loadError}</p>
      </div>
    );
  }

  if (!saved) {
    return (
      <div role="status" aria-label="Loading the business settings">
        <Skeleton className="h-5 w-40 rounded" />
        <Skeleton className="mt-2 h-3 w-full max-w-md rounded" />
        <div className="mt-7 grid grid-cols-1 gap-2 sm:grid-cols-2">
          {[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-[74px] rounded-[12px]" />)}
        </div>
      </div>
    );
  }

  if (!canManage) {
    return (
      <div>
        <SectionHead title="Business" hint={HINT} />
        <p className="text-[13px] text-foreground">
          {businessModelLabel(saved.business_model)} · metrics in {saved.currency}
        </p>
        <p className="mt-2 text-[12.5px] text-muted">Ask an owner or admin to change the model or the currency.</p>
      </div>
    );
  }

  return (
    <div>
      <SectionHead title="Business" hint={HINT} />

      <Block title="Business model">
        <BusinessModelPicker value={model} onChange={setModel} disabled={pending !== null} />
      </Block>

      <Block title="Reporting currency" hint="Money metrics are summed in this currency. Amounts sent in another one are stored but left out — there is no conversion.">
        <TextField value={currency} onChange={setCurrency} isDisabled={pending !== null} maxLength={3} isInvalid={!currencyValid} className="max-w-[160px]">
          <Label>ISO 4217 code</Label>
          <Input placeholder="EUR" className="uppercase" />
          <Description>EUR, USD, GBP…</Description>
        </TextField>
      </Block>

      {error ? (
        <Alert role="alert" status="danger" className="mb-4">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Description>{error}</Alert.Description>
          </Alert.Content>
        </Alert>
      ) : null}

      <div className="mb-8 flex items-center gap-3">
        <Button onPress={() => void save()} isDisabled={!dirty || !currencyValid || pending !== null} isPending={pending === "save"}>
          {pending === "save" ? "Saving…" : "Save changes"}
        </Button>
        {note ? <span className="text-[12.5px] text-muted">{note}</span> : null}
      </div>

      {saved.business_model !== "product" ? (
        <Block
          title="Template"
          hint={`Adds the record types, fields and views a ${businessModelLabel(saved.business_model)} business starts with. Additive: what already exists is kept, so it is safe to apply again.`}
          action={
            <Button size="sm" variant="secondary" onPress={() => void applyTemplate()} isPending={pending === "template"} isDisabled={pending !== null}>
              Apply template
            </Button>
          }
        >
          <p className="text-[12.5px] text-muted">
            Customise what it added in{" "}
            <button type="button" className="text-foreground underline underline-offset-2" onClick={() => onGo("record-types")}>Record types</button>
            , and connect your app with an{" "}
            <button type="button" className="text-foreground underline underline-offset-2" onClick={() => onGo("ingest-keys")}>ingest key</button>.
          </p>
        </Block>
      ) : null}
    </div>
  );
}
