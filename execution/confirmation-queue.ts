export class ConfirmationQueue {
  private tail: Promise<void> = Promise.resolve();

  async run<T>(confirm: () => Promise<T>): Promise<T> {
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => { release = resolve; });

    await previous.catch(() => undefined);
    try {
      return await confirm();
    } finally {
      release();
    }
  }
}
