import { describe, expect, test, vi } from "vitest";

import { LifecycleRegistry } from "../src/app/lifecycle.js";

describe("LifecycleRegistry", () => {
  test("closes resources in reverse order and is idempotent", async () => {
    const order: string[] = [];
    const registry = new LifecycleRegistry({ timeoutMs: 100 });
    const first = vi.fn(async () => void order.push("first"));
    const second = vi.fn(async () => void order.push("second"));

    registry.add("first", first);
    registry.add("second", second);
    await registry.close();
    await registry.close();

    expect(order).toEqual(["second", "first"]);
    expect(first).toHaveBeenCalledOnce();
    expect(second).toHaveBeenCalledOnce();
  });

  test("bounds a stuck closer and still closes earlier resources", async () => {
    const earlier = vi.fn(async () => undefined);
    const registry = new LifecycleRegistry({ timeoutMs: 5 });
    registry.add("earlier", earlier);
    registry.add("stuck", () => new Promise(() => undefined));

    await expect(registry.close()).rejects.toThrow(/stuck/);
    expect(earlier).toHaveBeenCalledOnce();
  });
});
