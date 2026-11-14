import { describe, expect, it, vi } from "vitest";

import { buildDispatcher, session } from "./test-dispatcher.js";

describe("Dispatcher: baseline.remove while a copy is reclaiming", () => {
  it("refuses the remove with DEVICE_BUSY naming the reclaiming device, and removes the baseline once its reclaim ends", async () => {
    const { clock, dispatcher, registry } = await buildDispatcher({
      driverOptions: { latencyMs: { shutdown: 1_000 } },
    });
    const admin = session({ role: "admin" });
    const operator = await dispatcher.dispatch(
      "lease.request",
      { model: "iPhone 17 Pro", osVersion: "26.5", platform: "ios" },
      session(),
    );
    await dispatcher.dispatch(
      "baseline.save",
      { leaseId: operator.lease.id, name: "checkout" },
      admin,
    );
    const copy = await dispatcher.dispatch(
      "lease.request",
      { baseline: "checkout", platform: "ios" },
      session(),
    );
    const stateOf = (): string | undefined =>
      registry.snapshot.devices.find((device) => device.id === copy.device.id)?.state;
    await dispatcher.dispatch("lease.release", { leaseId: copy.lease.id }, session());
    await vi.waitFor(() => expect(stateOf()).toBe("reclaiming"));

    const refusal = await dispatcher.dispatch("baseline.remove", { name: "checkout" }, admin).then(
      () => undefined,
      (rejected: unknown) => rejected,
    );

    expect(refusal).toMatchObject({
      code: "DEVICE_BUSY",
      details: { id: copy.device.id, reason: "reclaiming" },
    });
    await vi.waitFor(() => {
      clock.advance(1_000);
      expect(stateOf()).toBe("deleted");
    });
    expect(await dispatcher.dispatch("baseline.remove", { name: "checkout" }, admin)).toEqual({
      deletedDevices: [],
      name: "checkout",
      versions: [1],
    });
  });
});

describe("Dispatcher: baseline.remove while a copy is being made", () => {
  it("refuses the remove with DEVICE_BUSY and reason busy, naming the device, until the copy is leased", async () => {
    const { clock, dispatcher, registry } = await buildDispatcher({
      driverOptions: { latencyMs: { makeReady: 1_000 } },
    });
    const admin = session({ role: "admin" });
    const finish = async <Result>(pending: Promise<Result>): Promise<Result> => {
      let done = false;
      void pending.then(
        () => (done = true),
        () => (done = true),
      );
      await vi.waitFor(() => {
        clock.advance(1_000);
        expect(done).toBe(true);
      });
      return pending;
    };
    const operator = await finish(
      dispatcher.dispatch(
        "lease.request",
        { model: "iPhone 17 Pro", osVersion: "26.5", platform: "ios" },
        session(),
      ),
    );
    await dispatcher.dispatch(
      "baseline.save",
      { leaseId: operator.lease.id, name: "checkout" },
      admin,
    );
    const copyRequest = dispatcher.dispatch(
      "lease.request",
      { baseline: "checkout", platform: "ios" },
      session(),
    );
    await vi.waitFor(() =>
      expect(
        registry.snapshot.virtualDevices.some(
          (device) => device.spec.baseline?.name === "checkout" && device.state !== "deleted",
        ),
      ).toBe(true),
    );
    const making = registry.snapshot.virtualDevices.find(
      (device) => device.spec.baseline?.name === "checkout" && device.state !== "deleted",
    );

    const refusal = await dispatcher.dispatch("baseline.remove", { name: "checkout" }, admin).then(
      () => undefined,
      (rejected: unknown) => rejected,
    );

    expect(refusal).toMatchObject({
      code: "DEVICE_BUSY",
      details: { id: making?.id, reason: "busy" },
    });
    await finish(copyRequest);
  });
});

describe("Dispatcher: baseline.import", () => {
  it("keeps a copy of a device the worker did not make as the next version of the name, which a lease copies with the device's model and OS version and the requested mode, and refuses a device the driver cannot import or copy, keeping nothing", async () => {
    const { dispatcher, driver, eventBus } = await buildDispatcher({
      driverOptions: {
        slimmableOsVersions: ["26.5"],
        importableDevices: {
          "SIGNED-IN": {
            files: { "/token": "signed in" },
            model: "iPhone 17 Pro",
            osVersion: "26.5",
          },
        },
      },
    });
    const admin = session({ role: "admin" });
    const saved: unknown[] = [];
    eventBus.subscribe("baseline.saved", (event) => saved.push(event.payload));

    const imported = await dispatcher.dispatch(
      "baseline.import",
      { device: "SIGNED-IN", name: "signed-in", note: "test user" },
      admin,
    );
    const again = await dispatcher.dispatch(
      "baseline.import",
      { device: "SIGNED-IN", mode: "slim", name: "signed-in" },
      admin,
    );

    expect(imported).toMatchObject({
      baseline: {
        mode: "full",
        model: "iPhone 17 Pro",
        name: "signed-in",
        note: "test user",
        osVersion: "26.5",
        platform: "ios",
        version: 1,
      },
      device: "SIGNED-IN",
    });
    expect(again.baseline).toMatchObject({ mode: "slim", version: 2 });
    expect(saved).toEqual([
      expect.objectContaining({ deviceId: "SIGNED-IN", name: "signed-in", version: 1 }),
      expect.objectContaining({ deviceId: "SIGNED-IN", name: "signed-in", version: 2 }),
    ]);
    expect(saved[0]).not.toHaveProperty("leaseId");
    const copy = await dispatcher.dispatch(
      "lease.request",
      { baseline: "signed-in", platform: "ios" },
      session(),
    );
    expect(copy.device).toMatchObject({
      mode: "slim",
      spec: { model: "iPhone 17 Pro", osVersion: "26.5" },
    });
    expect(driver.deviceFile(copy.device.driverDeviceId, "/token")).toBe("signed in");

    driver.failOn("importSource", 3, new Error("simctl clone exited with code 1"));
    const outcomes = await Promise.all(
      [
        { device: "SIGNED-IN", name: "copy-failed" },
        { device: "ELSEWHERE", name: "refused" },
      ].map((input) =>
        dispatcher.dispatch("baseline.import", input, admin).then(
          () => undefined,
          (rejected: unknown) => rejected,
        ),
      ),
    );
    expect(outcomes).toEqual([
      expect.objectContaining({ code: "BASELINE_SAVE_FAILED", details: { name: "copy-failed" } }),
      expect.objectContaining({ code: "BAD_REQUEST" }),
    ]);
    const { baselines } = await dispatcher.dispatch("baseline.list", {}, admin);
    expect(baselines.map((baseline) => baseline.name)).toEqual(["signed-in"]);
  });
});
