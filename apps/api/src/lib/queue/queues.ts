/**
 * Queue catalogue — the single versioned declaration of what the worker runs
 * and when.
 *
 * The cadence lives here, in the repo — not in a hosting panel — and
 * `applySchedules()` reconciles the database against it on every worker boot,
 * including removing schedules that were dropped from this file. Ops view in
 * `docs/ops/worker.md`.
 */
import type { Queue, QueueOptions } from "pg-boss";

export const QUEUE_WEBHOOK_DRAIN = "webhook.drain";
export const QUEUE_CAPABILITY_HEALTH = "capability.health-check";
export const QUEUE_CAPABILITY_OAUTH_EXPIRE = "capability.oauth-expire";
export const QUEUE_ERRORS_RETENTION = "errors.retention";
export const QUEUE_TASKS_AUTO_ARCHIVE = "tasks.auto-archive";
export const QUEUE_SKILLS_SCHEDULE = "skills.schedule";
export const QUEUE_SKILLS_RUN_SCHEDULED = "skills.run-scheduled";
export const QUEUE_BUSINESS_ROLLUP = "business.rollup";
export const QUEUE_BUSINESS_ROLLUP_ALL = "business.rollup-all";

export interface QueueDefinition {
  name: string;
  /** pg-boss queue policy/retry settings (`policy` only matters at creation). */
  options: QueueOptions & Pick<Queue, "policy">;
  /** Cron expression, or null for on-demand-only queues. */
  cron: string | null;
  /** One-line description, mirrored into the ops runbook. */
  description: string;
}

/**
 * Every queue is `singleton`-shaped in spirit: the drains are idempotent and
 * guarded by a CAS lock in the domain code, but running one at a time keeps
 * the connection budget flat and the logs readable.
 */
const DRAIN_OPTIONS: QueueOptions = {
  // A batch can legitimately take a while (25 HTTP posts × 5s timeout).
  expireInSeconds: 300,
  retryLimit: 3,
  retryDelay: 30,
  retryBackoff: true,
  // A tick that never ran is worthless an hour later; the next one covers it.
  retentionSeconds: 3600,
  deleteAfterSeconds: 86_400,
};

export const QUEUES: readonly QueueDefinition[] = [
  {
    name: QUEUE_WEBHOOK_DRAIN,
    options: DRAIN_OPTIONS,
    cron: "* * * * *",
    description:
      "Drains due webhook_deliveries rows (src/lib/webhooks/worker.ts).",
  },
  {
    name: QUEUE_CAPABILITY_HEALTH,
    options: { ...DRAIN_OPTIONS, expireInSeconds: 900 },
    cron: "* * * * *",
    description:
      "Pings approved executable capabilities (src/lib/capabilities/health-check.ts).",
  },
  {
    name: QUEUE_CAPABILITY_OAUTH_EXPIRE,
    // Was a pg_cron job (migration 0034, removed by 0097) on the same
    // five-minute clock. Idempotent and row-locked in SQL, so a duplicate
    // tick from a second replica is harmless.
    options: DRAIN_OPTIONS,
    cron: "*/5 * * * *",
    description:
      "Expires abandoned capability OAuth attempts and deletes their Vault material (src/lib/capabilities/oauth-expiry.ts).",
  },
  {
    name: QUEUE_ERRORS_RETENTION,
    // Nothing like the drains: this runs once a day, takes as long as it
    // takes, and a tick that was missed is genuinely covered by the next one
    // — the predicate is "older than N days", not "since the last run", so
    // the job is idempotent and skipping one costs a day of extra rows.
    options: {
      expireInSeconds: 600,
      retryLimit: 2,
      retryDelay: 300,
      retryBackoff: true,
      retentionSeconds: 86_400,
      deleteAfterSeconds: 604_800,
    },
    // 04:20 UTC: the quietest hour, and offset from the round numbers every
    // other scheduler on the box reaches for.
    cron: "20 4 * * *",
    description:
      "Deletes error_events past their retention and the empty, unannotated error_groups left behind (src/lib/errors/retention.ts).",
  },
  {
    name: QUEUE_TASKS_AUTO_ARCHIVE,
    // Same shape as the retention purge: daily, idempotent ("done and
    // untouched for N days"), a missed tick is covered by the next one.
    options: {
      expireInSeconds: 600,
      retryLimit: 2,
      retryDelay: 300,
      retryBackoff: true,
      retentionSeconds: 86_400,
      deleteAfterSeconds: 604_800,
    },
    // 04:40 UTC, twenty minutes after the purge so the two never overlap.
    cron: "40 4 * * *",
    description:
      "Archives tasks and bugs that have been done and untouched for TASKS_AUTO_ARCHIVE_DAYS (30) days (src/lib/tasks/auto-archive.ts).",
  },
  {
    name: QUEUE_SKILLS_SCHEDULE,
    options: DRAIN_OPTIONS,
    // Five minutes is the resolution of a skill schedule: a digest due at
    // 09:00 runs by 09:05. Finer than that buys nothing for a weekly job.
    cron: "*/5 * * * *",
    description:
      "Enqueues a skills.run-scheduled job for every enabled skill_schedules row whose next_run_at is due, advancing the clock under a CAS (src/lib/skills/schedules.ts).",
  },
  {
    name: QUEUE_SKILLS_RUN_SCHEDULED,
    // One schedule per job, carried in the job data. A digest reads a week
    // of feed and may call the model; give it room.
    options: { ...DRAIN_OPTIONS, expireInSeconds: 900 },
    cron: null,
    description:
      "Runs one scheduled skill: the built-in weekly digest (src/lib/skills/digest.ts) or a skill node, then stamps last_run_at (src/lib/skills/schedules.ts).",
  },
  {
    name: QUEUE_BUSINESS_ROLLUP,
    options: { ...DRAIN_OPTIONS, expireInSeconds: 600 },
    cron: null,
    description:
      "Recomputes one workspace's business metric rollups from its events; enqueued by POST /api/workspaces/:ws/events, debounced per workspace (src/lib/business/rollup-job.ts).",
  },
  {
    name: QUEUE_BUSINESS_ROLLUP_ALL,
    options: DRAIN_OPTIONS,
    cron: "10 3 * * *",
    description:
      "Enqueues a business.rollup for every workspace with events, so the current day rolls over and a lost enqueue costs a day at most (src/lib/business/rollup-job.ts).",
  },
] as const;

export function queueByName(name: string): QueueDefinition | undefined {
  return QUEUES.find((q) => q.name === name);
}
