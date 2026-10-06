/** Reactive bookkeeping for one class of async work. */
export class AsyncOperation {
  pending = $state(0);
  error = $state<string | null>(null);
  #singleFlight = false;
  #closed = false;

  get isPending(): boolean {
    return this.pending > 0;
  }

  close(): void {
    this.#closed = true;
    this.pending = 0;
    this.#singleFlight = false;
  }

  async run<T>(
    work: () => Promise<T>,
    options: { singleFlight?: boolean } = {},
  ): Promise<T | undefined> {
    if (this.#closed) {
      return undefined;
    }
    if (options.singleFlight && this.#singleFlight) {
      return undefined;
    }
    if (options.singleFlight) {
      this.#singleFlight = true;
    }
    this.pending += 1;
    this.error = null;
    try {
      return await work();
    } catch (error) {
      if (!this.#closed) {
        this.error = error instanceof Error ? error.message : 'The operation failed.';
      }
      throw error;
    } finally {
      if (!this.#closed) {
        this.pending -= 1;
      }
      if (options.singleFlight && !this.#closed) {
        this.#singleFlight = false;
      }
    }
  }
}
