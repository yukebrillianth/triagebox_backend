/**
 * The system's time constants in one place, with the rules that tie them
 * together. docs/timing.md is the human-readable table; this file is what the
 * backend actually reads, and assertTimingInvariants() is what stops it booting
 * with a combination that makes the dashboard lie.
 */

/** Seconds between full station poll cycles (station CONFIG_TB_POLL_PERIOD_MS). */
export function pollPeriodSec(): number {
  return Number(process.env.STATION_POLL_PERIOD_SEC ?? 15);
}

/** Seconds without a sighting before an active node is marked OFFLINE. */
export function nodeOfflineSec(): number {
  return Number(process.env.NODE_OFFLINE_SEC ?? 45);
}

/**
 * Seconds before the node's own display calls the STM32 link stale. Lives in the
 * ESP32 firmware (LINK_STALE_MS, two copies that tb_ui_source_selftest keeps
 * equal); repeated here so the dashboard can show it.
 */
export const LINK_STALE_SEC = 45;

/**
 * Re-triage intervals the node's Menu offers (ui_settings_retriage_choices in
 * the ESP32 firmware; 0 = off is not listed). They live on the node, so this is
 * a mirror for the one rule below. 15/30/60 s were removed on 2026-10-23: every
 * re-triage needs a blood pressure, and that needs a 30-60 s recording.
 */
export const RETRIAGE_CHOICES_SEC = [60, 300, 900];
export const RETRIAGE_DEFAULT_SEC = 300;

/** First-measurement durations the node's Menu offers (the BP recording). */
export const MEASURE_CHOICES_SEC = [30, 60];

/**
 * The offline threshold must outlast several missed cycles: one lost reply is
 * normal on LoRa, and flapping OFFLINE/ONLINE on every dropped packet floods the
 * alert feed. Three cycles also matches the station's own LORA_POLL_MISS_LIMIT.
 */
export const OFFLINE_CYCLES_MIN = 3;

export function timingProblems(
  poll = pollPeriodSec(),
  offline = nodeOfflineSec(),
  retriage: number[] = RETRIAGE_CHOICES_SEC,
): string[] {
  const problems: string[] = [];
  if (!Number.isFinite(poll) || poll <= 0) {
    problems.push(`STATION_POLL_PERIOD_SEC must be > 0 (got ${poll})`);
  }
  if (!Number.isFinite(offline) || offline <= 0) {
    problems.push(`NODE_OFFLINE_SEC must be > 0 (got ${offline})`);
  }
  if (problems.length === 0 && offline < OFFLINE_CYCLES_MIN * poll) {
    problems.push(
      `NODE_OFFLINE_SEC (${offline}) must be >= ${OFFLINE_CYCLES_MIN} x the poll period (${poll} s = ${
        OFFLINE_CYCLES_MIN * poll
      } s), or one lost reply marks a healthy node OFFLINE`,
    );
  }
  /* A re-triage faster than the station polls produces verdicts the dashboard
   * never sees, so the shortest Menu choice must be >= one poll cycle. */
  if (problems.length === 0 && Math.min(...retriage) < poll) {
    problems.push(
      `shortest re-triage choice (${Math.min(...retriage)} s) must be >= the poll period (${poll} s), or the node re-triages between polls and the dashboard never sees it`,
    );
  }
  return problems;
}

export function assertTimingInvariants(): void {
  const problems = timingProblems();
  if (problems.length > 0) {
    throw new Error(`Invalid timing configuration:\n - ${problems.join('\n - ')}`);
  }
}
