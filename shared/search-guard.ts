/**
 * Monotonic query guard for async lookups: each new query takes the next
 * sequence number, and only the latest query may apply its results. An
 * older query that resolves late (slow module load, slow network) sees its
 * sequence no longer current and drops its results instead of overwriting
 * a newer answer.
 */
export class SearchGuard {
  private current = 0;
  next(): number {
    return ++this.current;
  }
  owns(seq: number): boolean {
    return seq === this.current;
  }
}
