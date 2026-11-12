"use client";

/**
 * CheckboxButtonGroup — multiple choice drawn as bordered tiles instead of
 * bare checkboxes. Used by the workspace picker of an org invitation.
 *
 * Built on HeroUI's CheckboxGroup/Checkbox, so focus,
 * keyboard, form values and `isDisabled` are React Aria's. The field root of
 * each item is `display: contents`; the tile is the field's clickable
 * content, which carries `data-selected` — the selected ring keys off it.
 * The indicator is the native control pinned to the tile's top-right corner.
 */
import type { ComponentProps, HTMLAttributes, ReactNode } from "react";
import { Checkbox, CheckboxGroup } from "@heroui/react";
import { cn } from "@bcontext-dev/contract/utils";

/** Shared tile look: surface card, hairline border, accent ring when selected. */
const TILE = cn(
  "relative flex cursor-pointer flex-col items-stretch gap-4 rounded-2xl border border-border bg-surface px-5 py-4 outline-none",
  "[-webkit-tap-highlight-color:transparent]",
  "data-[selected=true]:border-transparent data-[selected=true]:ring-2 data-[selected=true]:ring-accent",
  "data-[focus-visible=true]:ring-2 data-[focus-visible=true]:ring-focus",
  "data-[disabled=true]:pointer-events-none data-[disabled=true]:cursor-not-allowed data-[disabled=true]:opacity-50",
);
const INDICATOR = "absolute end-4 top-3";
const ITEM_CONTENT = "flex min-w-0 flex-col";

function ItemContent({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div data-slot="button-group-item-content" className={cn(ITEM_CONTENT, className)} {...rest} />;
}

function CheckboxRoot({
  className,
  children,
  ...rest
}: Omit<ComponentProps<typeof CheckboxGroup>, "children"> & { children?: ReactNode }) {
  return (
    <CheckboxGroup
      data-slot="checkbox-button-group"
      className={cn("flex gap-3", typeof className === "string" ? className : undefined)}
      {...rest}
    >
      {children}
    </CheckboxGroup>
  );
}

function CheckboxItem({
  className,
  children,
  ...rest
}: Omit<ComponentProps<typeof Checkbox>, "children" | "className"> & { className?: string; children?: ReactNode }) {
  return (
    <Checkbox data-slot="checkbox-button-group-item" className="contents" {...rest}>
      <Checkbox.Content className={cn(TILE, className)}>{children}</Checkbox.Content>
    </Checkbox>
  );
}

function CheckboxIndicator({ className }: { className?: string }) {
  return (
    <Checkbox.Control data-slot="checkbox-button-group-indicator" className={cn(INDICATOR, className)}>
      <Checkbox.Indicator />
    </Checkbox.Control>
  );
}

export const CheckboxButtonGroup = Object.assign(CheckboxRoot, {
  Item: CheckboxItem,
  Indicator: CheckboxIndicator,
  ItemContent,
});
