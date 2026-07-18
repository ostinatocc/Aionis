import { writeFileSync } from "node:fs";

import stableStringify from "fast-json-stable-stringify";

import {
  abortLiteRuntimeDeploymentSlotAuthorityProvisioning,
  installLiteRuntimeDeploymentSlotProvisioningObserverForTesting,
  provisionLiteRuntimeDeploymentSlotAuthority,
  resumeLiteRuntimeDeploymentSlotAuthorityProvisioning,
} from "../../../tools/runtime-deployment-authority/lite-runtime-deployment-slot-authority.js";
import {
  installLiteRuntimeDeploymentSlotProvisioningJournalFaultObserverForTesting,
  PROVISIONING_JOURNAL_FAULT_POINTS,
  type LiteRuntimeDeploymentSlotProvisioningJournalFaultPoint,
} from "../../../tools/runtime-deployment-authority/lite-runtime-deployment-slot-provisioning-journal.js";
import {
  closeLiteRuntimeDeploymentSlotPathAuthorityRoot,
  deriveLiteRuntimeDeploymentSlotPathCapability,
  openLiteRuntimeDeploymentSlotPathAuthorityRoot,
} from "../../../tools/runtime-deployment-authority/lite-runtime-deployment-slot-path-authority.js";
import {
  closeLiteRuntimeProtectedAuthorityDatabasePin,
  pinLiteRuntimeProtectedAuthorityDatabase,
} from "../../../packages/aionis-learning-authority/src/store/lite-runtime-protected-authority-database.js";

const PHASES = [
  "intent_durable",
  "pair_inodes_durable",
  "carrier_ready",
  "state_ready",
  "initial_witness_ready",
  "committed",
  "aborted",
] as const;

type Phase = typeof PHASES[number];
type Target = Phase | LiteRuntimeDeploymentSlotProvisioningJournalFaultPoint;
type Action = "abort" | "provision" | "resume";
type ObserverMode = "hold" | "kill";

function requiredArg(index: number, name: string): string {
  const value = process.argv[index];
  if (!value) throw new Error(`missing_${name}`);
  return value;
}

function assertAction(value: string): Action {
  if (value !== "abort" && value !== "provision" && value !== "resume") {
    throw new Error("invalid_recovery_child_action");
  }
  return value;
}

function assertObserverMode(value: string): ObserverMode {
  if (value !== "hold" && value !== "kill") {
    throw new Error("invalid_recovery_child_observer_mode");
  }
  return value;
}

function assertTarget(value: string): Target {
  if (!(PHASES as readonly string[]).includes(value)
    && !(PROVISIONING_JOURNAL_FAULT_POINTS as readonly string[]).includes(value)) {
    throw new Error("invalid_recovery_child_target");
  }
  return value as Target;
}

function assertTargetOccurrence(value: string | undefined): number {
  const canonical = value ?? "1";
  if (!/^[1-9]\d*$/u.test(canonical)) {
    throw new Error("invalid_recovery_child_target_occurrence");
  }
  const occurrence = Number.parseInt(canonical, 10);
  if (!Number.isSafeInteger(occurrence) || occurrence < 1) {
    throw new Error("invalid_recovery_child_target_occurrence");
  }
  return occurrence;
}

function stopForeverAtTarget(
  readyPath: string,
  target: Target,
  targetOccurrence: number,
): never {
  writeFileSync(
    readyPath,
    stableStringify({ target, target_occurrence: targetOccurrence, pid: process.pid }),
    { flag: "wx", mode: 0o600 },
  );
  process.kill(process.pid, "SIGSTOP");
  throw new Error("SIGSTOP unexpectedly returned without process termination");
}

async function main(): Promise<void> {
  const rootPath = requiredArg(2, "root_path");
  const expectedRootManifestSha256 = requiredArg(
    3,
    "expected_root_manifest_sha256",
  );
  const deploymentSlot = requiredArg(4, "deployment_slot");
  const runtimeDatabasePath = requiredArg(5, "runtime_database_path");
  const action = assertAction(requiredArg(6, "action"));
  const observerMode = assertObserverMode(requiredArg(7, "observer_mode"));
  const target = assertTarget(requiredArg(8, "target"));
  const holdReadyPath = process.argv[9] ?? "";
  const targetOccurrence = assertTargetOccurrence(process.argv[10]);
  if (observerMode === "hold" && holdReadyPath.length === 0) {
    throw new Error("missing_hold_ready_path");
  }

  const rootCapability = openLiteRuntimeDeploymentSlotPathAuthorityRoot({
    rootPath,
    expectedRootManifestSha256,
  });
  const slotPath = deriveLiteRuntimeDeploymentSlotPathCapability(
    rootCapability,
    deploymentSlot,
  );
  const runtimeDatabasePin = pinLiteRuntimeProtectedAuthorityDatabase(
    runtimeDatabasePath,
  );
  let observedCount = 0;
  const observeTarget = (observedTarget: Target): void => {
    if (observedTarget !== target) return;
    observedCount += 1;
    if (observedCount !== targetOccurrence) return;
    if (observerMode === "kill") {
      process.kill(process.pid, "SIGKILL");
      throw new Error("SIGKILL unexpectedly returned");
    }
    stopForeverAtTarget(holdReadyPath, target, targetOccurrence);
  };
  const disposePhaseObserver =
    installLiteRuntimeDeploymentSlotProvisioningObserverForTesting((phase) => {
      observeTarget(phase);
    });
  const disposeJournalObserver =
    installLiteRuntimeDeploymentSlotProvisioningJournalFaultObserverForTesting(
      (point) => { observeTarget(point); },
    );

  try {
    if (action === "provision") {
      let randomCall = 0;
      await Promise.resolve(provisionLiteRuntimeDeploymentSlotAuthority({
        slotPath,
        runtimeDatabasePin,
        now: new Date("2026-07-18T04:00:00.000Z"),
        randomBytesFactory: (size) => {
          randomCall += 1;
          return Buffer.alloc(size, 0x40 + randomCall);
        },
      }));
    } else if (action === "resume") {
      await Promise.resolve(resumeLiteRuntimeDeploymentSlotAuthorityProvisioning({
        slotPath,
        runtimeDatabasePin,
        now: new Date("2026-07-18T04:00:00.000Z"),
        randomBytesFactory: () => {
          throw new Error("recovery_must_not_allocate_a_second_provisioning_identity");
        },
      }));
    } else {
      await Promise.resolve(abortLiteRuntimeDeploymentSlotAuthorityProvisioning({
        slotPath,
      }));
    }
    throw new Error(
      `target provisioning point occurrence was not observed: ${target}`
      + ` occurrence ${targetOccurrence}; observed ${observedCount}`,
    );
  } finally {
    disposeJournalObserver();
    disposePhaseObserver();
    closeLiteRuntimeProtectedAuthorityDatabasePin(runtimeDatabasePin);
    closeLiteRuntimeDeploymentSlotPathAuthorityRoot(rootCapability);
  }
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
