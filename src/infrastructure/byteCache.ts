export class BoundedByteCache {
  private readonly values = new Map<string, Uint8Array>();
  private readonly pending = new Map<string, Promise<Uint8Array>>();
  private totalBytes = 0;

  public constructor(
    private readonly maxEntryBytes: number,
    private readonly maxTotalBytes: number,
  ) {}

  public get sizeBytes(): number {
    return this.totalBytes;
  }

  public async getOrLoad(
    key: string,
    loader: () => Promise<Uint8Array>,
  ): Promise<Uint8Array> {
    const existing = this.values.get(key);
    if (existing !== undefined) {
      this.values.delete(key);
      this.values.set(key, existing);
      return existing;
    }
    const inFlight = this.pending.get(key);
    if (inFlight !== undefined) return inFlight;

    const promise = loader().then((value) => {
      if (
        value.byteLength <= this.maxEntryBytes &&
        value.byteLength <= this.maxTotalBytes
      ) {
        this.evictFor(value.byteLength);
        this.values.set(key, value);
        this.totalBytes += value.byteLength;
      }
      return value;
    });
    this.pending.set(key, promise);
    try {
      return await promise;
    } finally {
      this.pending.delete(key);
    }
  }

  public clear(): void {
    this.values.clear();
    this.totalBytes = 0;
  }

  private evictFor(incomingBytes: number): void {
    while (this.totalBytes + incomingBytes > this.maxTotalBytes) {
      const oldest = this.values.entries().next().value;
      if (oldest === undefined) {
        this.values.clear();
        this.totalBytes = 0;
        return;
      }
      this.values.delete(oldest[0]);
      this.totalBytes -= oldest[1].byteLength;
    }
  }
}
