/**
 * Lamport logical clock for multi-writer operation ordering.
 * Each agent maintains its own clock. On local events, tick().
 * On receiving remote events, merge(received) to stay ahead.
 * Ties are broken by agent ID (lexicographic) for deterministic total order.
 */
export class LamportClock {
  private counter: number;

  constructor(initial = 0) {
    this.counter = initial;
  }

  /** Increment and return the new value (for local events). */
  tick(): number {
    return ++this.counter;
  }

  /** Merge with a received clock value and increment. */
  merge(received: number): number {
    this.counter = Math.max(this.counter, received) + 1;
    return this.counter;
  }

  /** Current clock value without incrementing. */
  get current(): number {
    return this.counter;
  }
}
