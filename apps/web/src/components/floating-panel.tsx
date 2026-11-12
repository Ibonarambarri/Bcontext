"use client";

/**
 * The floating window the node panel (`node-floating-panel.tsx`) opens in
 * over the active view: half of the surface by default, all of it when
 * expanded, with a border, shadow, slide-in and Esc. Kept apart from the
 * node panel so the window geometry has one owner.
 *
 * Positioning is `absolute` against the shell's "Active page" region, of
 * which the panel is a direct child.
 *
 * Esc closes the panel opened last, not every open one: that is the small
 * stack below; Alt+←/→ and other keys stay with each panel.
 */

import { useEffect, useRef } from "react";
import { Button, Surface, Tooltip } from "@heroui/react";
import { cn } from "@bcontext-dev/contract/utils";

// Close callbacks of the panels currently open, oldest first. Esc pops the
// newest. Module-level on purpose: the panels do not share a parent.
const openStack: Array<() => void> = [];
let escListener: ((event: KeyboardEvent) => void) | null = null;

function syncEscListener() {
  if (openStack.length > 0 && !escListener) {
    escListener = (event) => {
      if (event.key !== "Escape") return;
      const target = event.target as HTMLElement | null;
      const typing = Boolean(target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable));
      if (typing) return;
      const top = openStack[openStack.length - 1];
      if (!top) return;
      event.preventDefault();
      top();
    };
    window.addEventListener("keydown", escListener);
  } else if (openStack.length === 0 && escListener) {
    window.removeEventListener("keydown", escListener);
    escListener = null;
  }
}

export type FloatingPanelSize = "half" | "full";

export function FloatingPanel({
  open,
  size,
  label,
  onClose,
  className,
  children,
  ...rest
}: {
  open: boolean;
  size: FloatingPanelSize;
  label: string;
  onClose: () => void;
  className?: string;
  children: React.ReactNode;
} & Record<`data-${string}`, string | undefined>) {
  // The stack entry is one stable function per panel instance that reads the
  // latest onClose: callers pass inline closures, and re-registering on every
  // render would move a panel back to the top of the stack while another one
  // sits above it — Esc would then close the wrong panel.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const entryRef = useRef<() => void>(() => onCloseRef.current());

  useEffect(() => {
    if (!open) return;
    const entry = entryRef.current;
    openStack.push(entry);
    syncEscListener();
    return () => {
      const index = openStack.lastIndexOf(entry);
      if (index >= 0) openStack.splice(index, 1);
      syncEscListener();
    };
  }, [open]);

  return (
    <Surface
      variant="default"
      role="dialog"
      aria-label={label}
      aria-hidden={!open}
      data-floating-panel
      data-size={size}
      {...rest}
      className={cn(
        "absolute flex flex-col overflow-hidden rounded-xl border border-[var(--line)] p-0 shadow-xl transition-[transform,opacity,width,inset] duration-200 ease-out",
        size === "full"
          ? "inset-y-2 left-2 right-2 md:inset-y-3 md:left-3 md:right-3"
          : "inset-y-3 right-3 w-[min(calc(50%-18px),calc(100%-1.5rem))]",
        open ? "translate-x-0 opacity-100" : "pointer-events-none translate-x-4 opacity-0",
        className,
      )}
    >
      {children}
    </Surface>
  );
}

/** One icon button of a panel's header toolbar, tooltip included. */
export function FloatingPanelAction({ label, disabled = false, onPress, children }: { label: string; disabled?: boolean; onPress: () => void; children: React.ReactNode }) {
  return (
    <Tooltip delay={400}>
      <Button isIconOnly variant="ghost" isDisabled={disabled} onPress={onPress} aria-label={label} className="icon-btn">
        {children}
      </Button>
      <Tooltip.Content>{label}</Tooltip.Content>
    </Tooltip>
  );
}
