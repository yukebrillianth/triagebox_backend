/**
 * Packet loss from the poll schedule.
 *
 * The station polls each node once per cycle, so over a window the number of
 * polls EXPECTED is the window length divided by the cycle period. Received is
 * the count of answered polls (LinkSample rows). The window starts at the first
 * answer, so a node that has just been added does not start life at 100% loss,
 * and ends at the last answer when the node is OFFLINE, so time it was switched
 * off counts as offline rather than as lost packets.
 */
export interface LinkWindow {
  expected: number;
  received: number;
  lossPct: number | null;
}

export function linkWindow(
  fromMs: number,
  toMs: number,
  periodSec: number,
  received: number,
): LinkWindow {
  if (!(periodSec > 0) || toMs < fromMs) {
    return { expected: 0, received, lossPct: null };
  }
  // +1: the first poll of the window is the one that opened it.
  const expected = Math.floor((toMs - fromMs) / (periodSec * 1000)) + 1;
  const lossPct =
    expected > 0
      ? Math.round(Math.max(0, 1 - received / expected) * 1000) / 10
      : null;
  return { expected, received, lossPct };
}
