/**
 * Job handlers — thin adapters, zero domain logic.
 *
 * Each handler is one call into a domain function (`processDeliveries`,
 * `purgeErrorTelemetry`, `scheduleDueSkills`, …) that owns the real work. Those functions take a CAS lock on `status` per row, which is what
 * keeps a second worker replica harmless.
 *
 * Everything this file imports ends up in the worker bundle, so it must stay
 * free of request-only dependencies — `build:worker` fails on a violation.
 */
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { processDeliveries } from "@/lib/webhooks/worker";
import { purgeErrorTelemetry } from "@/lib/errors/retention";
import { archiveStaleDoneTasks } from "@/lib/tasks/auto-archive";
import { runScheduledSkill, scheduleDueSkills } from "@/lib/skills/schedules";
import {
  QUEUE_ERRORS_RETENTION,
  QUEUE_SKILLS_RUN_SCHEDULED,
  QUEUE_SKILLS_SCHEDULE,
  QUEUE_TASKS_AUTO_ARCHIVE,
  QUEUE_WEBHOOK_DRAIN,
} from "./queues";

/** `data` is the job payload; the scheduled drains carry none and ignore it. */
export type JobHandler = (data?: Record<string, unknown>) => Promise<Record<string, unknown>>;

function str(data: Record<string, unknown> | undefined, key: string): string | null {
  const v = data?.[key];
  return typeof v === "string" && v.length > 0 ? v : null;
}

export const HANDLERS: Record<string, JobHandler> = {
  [QUEUE_WEBHOOK_DRAIN]: async () => ({
    ...(await processDeliveries(getSupabaseAdmin())),
  }),
  // The only handler here that is not a drain: it deletes rather than
  // delivers, and it is what keeps the error tables bounded.
  [QUEUE_ERRORS_RETENTION]: async () => ({
    ...(await purgeErrorTelemetry()),
  }),
  // Housekeeping too: done for thirty quiet days → archived.
  [QUEUE_TASKS_AUTO_ARCHIVE]: async () => ({
    ...(await archiveStaleDoneTasks(getSupabaseAdmin())),
  }),
  // Scheduled skills: the clock (every five minutes) and the run it enqueues.
  [QUEUE_SKILLS_SCHEDULE]: async () => ({
    ...(await scheduleDueSkills(getSupabaseAdmin())),
  }),
  [QUEUE_SKILLS_RUN_SCHEDULED]: async (data) => ({
    ...(await runScheduledSkill(getSupabaseAdmin(), {
      schedule_id: str(data, "schedule_id") ?? "",
      workspace_id: str(data, "workspace_id") ?? undefined,
      scheduled_for: str(data, "scheduled_for"),
    })),
  }),
};
