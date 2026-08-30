export const CONFIRMATION_TIMEOUT_MS = 30_000;

export class ConfirmationQueue {
  private tail: Promise<void> = Promise.resolve();
  private generation = 0;

  reset(): void {
    this.generation++;
  }

  async confirm(show: () => Promise<boolean>): Promise<boolean> {
    const generation = this.generation;
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => { release = resolve; });

    await previous.catch(() => undefined);
    if (generation !== this.generation) {
      release();
      return false;
    }

    try {
      const allowed = await show();
      return generation === this.generation && allowed;
    } finally {
      release();
    }
  }
}
