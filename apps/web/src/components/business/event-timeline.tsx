/**
 * A subject's business events, newest first, one line each: when, and what
 * happened in words (`describeEvent`). Server component.
 *
 * Who uses it: `record-360.tsx`. Swappable: the business views work ships a
 * timeline component of its own; when it lands, this becomes an adapter
 * over it (both take the contract's `BusinessEvent[]`).
 */
import type { BusinessEvent } from "@bcontext-dev/contract/business/events";
import { describeEvent } from "@/lib/business/records";

export function EventTimeline({ events, currency, limit = 20 }: { events: BusinessEvent[]; currency: string; limit?: number }) {
  const sorted = [...events].sort((a, b) => b.occurred_at.localeCompare(a.occurred_at)).slice(0, limit);
  if (sorted.length === 0) {
    return <p className="text-[12.5px] text-muted">No events for this record yet.</p>;
  }
  return (
    <ol className="relative space-y-2.5 border-l border-[var(--line)] pl-4">
      {sorted.map((event) => (
        <li key={event.id} className="relative">
          <span aria-hidden="true" className="absolute -left-[21px] top-1.5 size-2 rounded-full bg-[var(--accent)]" />
          <div className="text-[13px] text-foreground">{describeEvent(event, currency)}</div>
          <time dateTime={event.occurred_at} className="text-[11.5px] text-muted">
            {new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }).format(new Date(event.occurred_at))}
          </time>
        </li>
      ))}
    </ol>
  );
}
