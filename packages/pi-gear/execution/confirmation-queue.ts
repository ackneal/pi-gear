export const CONFIRMATION_TIMEOUT_MS = 30_000;

export class ConfirmationQueue {
  private tail: Promise<void> = Promise.resolve();
  private session = new AbortController();

  reset(): void {
    const previous = this.session;
    this.session = new AbortController();
    previous.abort();
  }

  confirm(show: (signal: AbortSignal) => Promise<boolean>, signal?: AbortSignal): Promise<boolean> {
    return this.prompt(show, false, signal);
  }

  prompt<T>(show: (signal: AbortSignal) => Promise<T>, fallback: T, signal?: AbortSignal): Promise<T> {
    const session = this.session.signal;
    if (session.aborted || signal?.aborted) return Promise.resolve(fallback);

    const controller = new AbortController();
    let resolve!: (result: T) => void;
    let reject!: (error: unknown) => void;
    const result = new Promise<T>((accept, fail) => { resolve = accept; reject = fail; });
    const cleanup = () => {
      session.removeEventListener("abort", abort);
      signal?.removeEventListener("abort", abort);
    };
    const abort = () => {
      cleanup();
      resolve(fallback);
      controller.abort();
    };
    session.addEventListener("abort", abort, { once: true });
    signal?.addEventListener("abort", abort, { once: true });

    // Cancellation completes the request, not UI ownership. An editor without
    // cancellation must settle before another callback may use the UI.
    this.tail = this.tail.then(async () => {
      try {
        if (controller.signal.aborted) return;
        const outcome = await show(controller.signal);
        resolve(controller.signal.aborted ? fallback : outcome);
      } catch (error) {
        reject(error);
      } finally {
        cleanup();
      }
    });
    return result;
  }
}
