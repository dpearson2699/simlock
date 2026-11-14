import type { z } from "zod";

import type { OPERATIONS } from "../contract/index.js";
import {
  BaselineImportRefusedError,
  BaselineSaveFailedError,
  type BaselineService,
  type DeviceRecord,
  type LeaseRecord,
  UnknownLeaseError,
} from "../core/index.js";
import { DispatchError } from "./dispatch.js";

type Input<Op extends "baseline.import" | "baseline.save"> = z.infer<
  (typeof OPERATIONS)[Op]["input"]
>;

/** why: the two operations that add a baseline version, and how each turns a refusal or a failed copy into its code; the dispatcher only routes to them. */
export async function saveBaseline(
  baselines: Pick<BaselineService, "save"> | undefined,
  snapshot: { readonly leases: readonly LeaseRecord[]; readonly devices: readonly DeviceRecord[] },
  input: Input<"baseline.save">,
  requesterId: string,
): Promise<unknown> {
  if (baselines === undefined) throw new DispatchError("INTERNAL", "Baselines are unavailable");
  const lease = snapshot.leases.find((candidate) => candidate.id === input.leaseId);
  if (lease === undefined) throw new UnknownLeaseError(input.leaseId);
  const held = snapshot.devices.find((candidate) => candidate.id === lease.deviceId);
  if (held?.physical === true) {
    throw new DispatchError(
      "BAD_REQUEST",
      `lease ${lease.id} is on a physical device; only a simulator or emulator can be saved as a baseline`,
    );
  }
  try {
    return await baselines.save({
      leaseId: input.leaseId,
      name: input.name,
      ...(input.note === undefined ? {} : { note: input.note }),
      requesterId,
    });
  } catch (error: unknown) {
    throw saveFailure(error);
  }
}

export async function importBaseline(
  baselines: Pick<BaselineService, "import"> | undefined,
  input: Input<"baseline.import">,
  requesterId: string,
): Promise<unknown> {
  if (baselines === undefined) throw new DispatchError("INTERNAL", "Baselines are unavailable");
  try {
    const imported = await baselines.import({
      deviceId: input.device,
      mode: input.mode ?? "full",
      name: input.name,
      ...(input.note === undefined ? {} : { note: input.note }),
      platform: "ios",
      requesterId,
    });
    return { baseline: imported.baseline, device: imported.deviceId };
  } catch (error: unknown) {
    if (error instanceof BaselineImportRefusedError) {
      throw new DispatchError("BAD_REQUEST", error.message);
    }
    throw saveFailure(error);
  }
}

function saveFailure(error: unknown): unknown {
  if (!(error instanceof BaselineSaveFailedError)) return error;
  return new DispatchError("BASELINE_SAVE_FAILED", error.message, {
    ...(error.leaseId === undefined ? {} : { leaseId: error.leaseId }),
    name: error.baselineName,
  });
}
