export interface ClockPort {
  /** Wall-clock time, for timestamps that are recorded. */
  now(): Date;
  /** Monotonic milliseconds, for durations that are measured. Never for timestamps. */
  monotonicMs(): number;
}
