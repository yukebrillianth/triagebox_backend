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
 * The offline threshold must outlast several missed cycles: one lost reply is
 * normal on LoRa, and flapping OFFLINE/ONLINE on every dropped packet floods the
 * alert feed. Three cycles also matches the station's own LORA_POLL_MISS_LIMIT.
 */
export const OFFLINE_CYCLES_MIN = 3;

export function timingProblems(
  poll = pollPeriodSec(),
  offline = nodeOfflineSec(),
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
  return problems;
}

export function assertTimingInvariants(): void {
  const problems = timingProblems();
  if (problems.length > 0) {
    throw new Error(`Invalid timing configuration:\n - ${problems.join('\n - ')}`);
  }
}
