const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const INTERVAL_MS = 100;

export class Spinner {
  private frameIndex = 0;
  private timer: ReturnType<typeof setInterval> | undefined;
  private readonly onFrame: () => void;

  constructor(onFrame: () => void) { this.onFrame = onFrame; }

  get frame(): string { return FRAMES[this.frameIndex] ?? ""; }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.frameIndex = (this.frameIndex + 1) % FRAMES.length;
      this.onFrame();
    }, INTERVAL_MS);
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = undefined;
  }

  dispose(): void { this.stop(); }
}
