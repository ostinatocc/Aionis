import assert from "node:assert/strict";
import {
  chmodSync,
  closeSync,
  constants,
  mkdtempSync,
  openSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  loadContinuationRuntimeV1ProvisioningConfig,
  publicContinuationRuntimeV1ProvisioningConfig,
} from "../../src/runtime-v1/provisioning-config.js";
import { runContinuationRuntimeV1Provisioning } from
  "../../src/runtime-v1/provisioning-entry.js";
import {
  assertPrivateAssignmentSeedDescriptor,
  assertPrivateAssignmentSeedDescriptorStable,
} from
  "../../src/runtime-v1/provisioning-seed-descriptor.js";

const ROOT_SHA = "a".repeat(64);

function environment(
  extra: Readonly<Record<string, string | undefined>> = {},
): Readonly<Record<string, string | undefined>> {
  return {
    AIONIS_DATA_PATH: "/tmp/aionis-provisioning/runtime.sqlite",
    AIONIS_TRUST_ROOT_PUBLIC_KEY_PATH: "/tmp/aionis-provisioning/root.pub.pem",
    AIONIS_TRUST_ROOT_SHA256: ROOT_SHA,
    ...extra,
  };
}

test("provisioner fails closed before reading config or descriptors on unsupported platforms", async () => {
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform");
  assert.ok(descriptor);
  try {
    Object.defineProperty(process, "platform", { ...descriptor, value: "win32" });
    await assert.rejects(
      runContinuationRuntimeV1Provisioning({}),
      /continuation_runtime_v1_host_platform_unsupported/u,
    );
  } finally {
    Object.defineProperty(process, "platform", descriptor);
  }
});

test("offline provisioner exposes only pinned public-root and optional seed-fd posture", () => {
  const withoutSeed = loadContinuationRuntimeV1ProvisioningConfig(environment());
  assert.equal(withoutSeed.assignmentSeedFd, null);
  assert.deepEqual(publicContinuationRuntimeV1ProvisioningConfig(withoutSeed), {
    dataPathConfigured: true,
    trustRootPublicKeyPathConfigured: true,
    trustRootSha256: ROOT_SHA,
    assignmentSeedFdConfigured: false,
  });

  const withSeed = loadContinuationRuntimeV1ProvisioningConfig(environment({
    AIONIS_PROVISIONING_SEED_FD: "3",
  }));
  assert.equal(withSeed.assignmentSeedFd, 3);
  assert.equal(
    publicContinuationRuntimeV1ProvisioningConfig(withSeed).assignmentSeedFdConfigured,
    true,
  );
});

test("offline provisioner rejects every daemon, worker, provider, signer, and root-private surface", () => {
  for (const [field, value] of [
    ["AIONIS_HOST_API_KEY", "host-secret"],
    ["AIONIS_OPERATOR_API_KEY", "operator-secret"],
    ["AIONIS_EMBEDDING_API_KEY", "provider-secret"],
    ["AIONIS_EFFECT_SIGNER_PRIVATE_KEY_PATH", "/tmp/effect.key"],
    ["AIONIS_TRUST_ROOT_PRIVATE_KEY_PATH", "/tmp/root.key"],
    ["AIONIS_WORKER_ROLE", "effect"],
  ] as const) {
    assert.throws(
      () => loadContinuationRuntimeV1ProvisioningConfig(environment({ [field]: value })),
      new RegExp(`unknown_AIONIS_fields:${field}`, "u"),
    );
  }
});

test("seed descriptor is a canonical bounded inherited descriptor", () => {
  for (const value of ["0", "2", "03", "1025", "-1", "3 "]) {
    assert.throws(
      () => loadContinuationRuntimeV1ProvisioningConfig(environment({
        AIONIS_PROVISIONING_SEED_FD: value,
      })),
      /provisioning_config_invalid/u,
    );
  }
});

test("regular seed descriptors require exact size, private mode, and safe type", () => {
  const root = mkdtempSync(join(tmpdir(), "aionis-v1-seed-fd-"));
  const seedPath = join(root, "seed.bin");
  const directoryFd = openSync(root, "r");
  try {
    writeFileSync(seedPath, Buffer.alloc(32, 7), { mode: 0o600 });
    let seedFd = openSync(seedPath, "r");
    try {
      assert.doesNotThrow(() => assertPrivateAssignmentSeedDescriptor(seedFd));
    } finally {
      closeSync(seedFd);
    }

    chmodSync(seedPath, 0o644);
    seedFd = openSync(seedPath, "r");
    try {
      assert.throws(
        () => assertPrivateAssignmentSeedDescriptor(seedFd),
        /assignment_seed_permissions_invalid/u,
      );
    } finally {
      closeSync(seedFd);
    }

    writeFileSync(seedPath, Buffer.alloc(31, 7));
    chmodSync(seedPath, 0o600);
    chmodSync(seedPath, 0o600);
    seedFd = openSync(seedPath, "r");
    try {
      assert.throws(
        () => assertPrivateAssignmentSeedDescriptor(seedFd),
        /assignment_seed_length_invalid/u,
      );
    } finally {
      closeSync(seedFd);
    }

    assert.throws(
      () => assertPrivateAssignmentSeedDescriptor(directoryFd),
      /assignment_seed_descriptor_type_invalid/u,
    );
  } finally {
    closeSync(directoryFd);
    rmSync(root, { recursive: true, force: true });
  }
});

test("FIFO seed descriptors require owner-private single-link posture and stable identity", () => {
  const root = mkdtempSync(join(tmpdir(), "aionis-v1-seed-fifo-"));
  const fifo = join(root, "seed.fifo");
  try {
    execFileSync("mkfifo", ["-m", "600", fifo]);
    let descriptor = openSync(fifo, constants.O_RDWR);
    try {
      const before = assertPrivateAssignmentSeedDescriptor(descriptor);
      assert.doesNotThrow(() => assertPrivateAssignmentSeedDescriptorStable(
        descriptor,
        before,
      ));
      chmodSync(fifo, 0o400);
      assert.throws(
        () => assertPrivateAssignmentSeedDescriptorStable(descriptor, before),
        /assignment_seed_changed_during_read/u,
      );
    } finally {
      closeSync(descriptor);
    }
    chmodSync(fifo, 0o666);
    descriptor = openSync(fifo, constants.O_RDWR);
    try {
      assert.throws(
        () => assertPrivateAssignmentSeedDescriptor(descriptor),
        /assignment_seed_permissions_invalid/u,
      );
    } finally {
      closeSync(descriptor);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
