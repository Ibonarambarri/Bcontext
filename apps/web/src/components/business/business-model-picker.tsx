"use client";

/**
 * Four cards — B2B, B2C, Marketplace, Just product — each with its one line.
 * A pressed-button group, the same family as the starting-point cards of the
 * new workspace dialog, so the two questions in that dialog read alike.
 *
 * Who uses it: `app/workspaces/new-workspace-modal.tsx` (on creation) and the
 * workspace panel's Business section. Controlled; it writes nothing itself.
 */
import { Button } from "@heroui/react";
import { cn } from "@bcontext-dev/contract/utils";
import type { BusinessModel } from "@bcontext-dev/contract/business/record-types";
import { BUSINESS_MODEL_OPTIONS } from "@/lib/business/models";

export function BusinessModelPicker({
  value,
  onChange,
  disabled = false,
}: {
  value: BusinessModel;
  onChange: (next: BusinessModel) => void;
  disabled?: boolean;
}) {
  return (
    <div role="group" aria-label="Business model" className="grid grid-cols-1 gap-2 sm:grid-cols-2">
      {BUSINESS_MODEL_OPTIONS.map((option) => {
        const active = option.id === value;
        return (
          <Button
            key={option.id}
            type="button"
            variant="ghost"
            aria-pressed={active}
            isDisabled={disabled}
            onPress={() => onChange(option.id)}
            className={cn(
              // HeroUI's button is fit-content and nowrap; a card wraps.
              "flex h-auto w-full min-w-0 flex-col items-start gap-1 whitespace-normal rounded-[12px] border px-3.5 py-3 text-left font-normal transition-colors",
              active
                ? "border-[var(--ink)] bg-[var(--paper)] shadow-[inset_0_0_0_1px_var(--ink)]"
                : "border-[var(--line)] bg-[var(--paper-2)] hover:border-[var(--ink-3)]",
            )}
          >
            <span className="block text-[13.5px] font-medium text-foreground">{option.label}</span>
            <span className="block text-[12px] leading-[1.45] text-muted">{option.line}</span>
          </Button>
        );
      })}
    </div>
  );
}
