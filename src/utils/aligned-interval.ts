export function getDelayUntilNextAlignedTick(
  intervalMs: number,
  nowMs = Date.now()
): number {
  const safeIntervalMs = Math.max(1, Math.floor(intervalMs));
  const remainder = nowMs % safeIntervalMs;

  return remainder === 0 ? safeIntervalMs : safeIntervalMs - remainder;
}
