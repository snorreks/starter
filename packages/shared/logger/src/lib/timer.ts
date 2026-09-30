// packages/shared/logger/src/lib/timer.ts

import type { TimerInterface } from '@starter/schemas/logging';

export class Timer implements TimerInterface {
  #start = Date.now();
  #end: number | undefined;

  get elapsedMs(): number {
    return (this.#end ?? Date.now()) - this.#start;
  }

  end(): number {
    this.#end = Date.now();
    return this.elapsedMs;
  }

  reset(): void {
    this.#start = Date.now();
    this.#end = undefined;
  }
}
