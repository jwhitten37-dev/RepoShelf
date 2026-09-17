import { describe, expect, it, vi } from "vitest";
import { BoundedByteCache } from "../src/infrastructure/byteCache.js";

describe("BoundedByteCache", () => {
  it("deduplicates concurrent loads", async () => {
    const cache = new BoundedByteCache(10, 20);
    let resolve!: (value: Uint8Array) => void;
    const pending = new Promise<Uint8Array>((done) => {
      resolve = done;
    });
    const loader = vi.fn(() => pending);

    const first = cache.getOrLoad("same", loader);
    const second = cache.getOrLoad("same", loader);
    resolve(new Uint8Array([1, 2]));

    await expect(Promise.all([first, second])).resolves.toEqual([
      new Uint8Array([1, 2]),
      new Uint8Array([1, 2]),
    ]);
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it("evicts the least recently used entry by total bytes", async () => {
    const cache = new BoundedByteCache(4, 6);
    const loaderA = vi.fn(() => Promise.resolve(new Uint8Array(3)));
    const loaderB = vi.fn(() => Promise.resolve(new Uint8Array(3)));
    const loaderC = vi.fn(() => Promise.resolve(new Uint8Array(3)));

    await cache.getOrLoad("a", loaderA);
    await cache.getOrLoad("b", loaderB);
    await cache.getOrLoad("a", loaderA);
    await cache.getOrLoad("c", loaderC);
    await cache.getOrLoad("b", loaderB);

    expect(loaderA).toHaveBeenCalledTimes(1);
    expect(loaderB).toHaveBeenCalledTimes(2);
    expect(cache.sizeBytes).toBe(6);
  });

  it("does not retain oversized entries", async () => {
    const cache = new BoundedByteCache(2, 10);
    const loader = vi.fn(() => Promise.resolve(new Uint8Array(3)));
    await cache.getOrLoad("large", loader);
    await cache.getOrLoad("large", loader);
    expect(loader).toHaveBeenCalledTimes(2);
    expect(cache.sizeBytes).toBe(0);
  });

  it("does not cache failed loads", async () => {
    const cache = new BoundedByteCache(10, 10);
    const loader = vi.fn(() => Promise.reject(new Error("failed")));
    await expect(cache.getOrLoad("bad", loader)).rejects.toThrow("failed");
    await expect(cache.getOrLoad("bad", loader)).rejects.toThrow("failed");
    expect(loader).toHaveBeenCalledTimes(2);
  });
});
