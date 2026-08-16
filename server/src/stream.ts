interface StreamResponse {
  destroyed: boolean;
  writableEnded: boolean;
  write(chunk: string): boolean;
  once(event: "drain", listener: () => void): unknown;
  off(event: "drain", listener: () => void): unknown;
  destroy(): unknown;
  end(): unknown;
}

/**
 * Bounds each SSE client's buffered data to one backpressured write. A client
 * that does not drain before the deadline, or receives another event while
 * still blocked, is disconnected and can fall back to polling.
 */
export class BoundedSseWriter {
  private blocked = false;
  private closed = false;
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly response: StreamResponse,
    private readonly backpressureMs: number,
    private readonly onClose: () => void,
  ) {}

  private readonly handleDrain = (): void => {
    this.blocked = false;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
  };

  private finish(destroy: boolean): void {
    if (this.closed) return;
    this.closed = true;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    this.response.off("drain", this.handleDrain);
    if (destroy && !this.response.destroyed) this.response.destroy();
    this.onClose();
  }

  write(chunk: string): boolean {
    if (this.closed || this.response.destroyed || this.response.writableEnded) {
      this.finish(false);
      return false;
    }
    if (this.blocked) {
      this.finish(true);
      return false;
    }

    try {
      if (!this.response.write(chunk)) {
        this.blocked = true;
        this.response.once("drain", this.handleDrain);
        this.timer = setTimeout(() => this.finish(true), this.backpressureMs);
        this.timer.unref();
      }
      return true;
    } catch {
      this.finish(true);
      return false;
    }
  }

  close(): void {
    this.finish(false);
  }

  end(): void {
    try {
      if (!this.response.writableEnded) this.response.end();
    } finally {
      this.finish(false);
    }
  }
}
