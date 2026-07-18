import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { type TestContext } from "node:test";

import stableStringify from "fast-json-stable-stringify";

import {
  assertLiteRuntimeDeploymentSlotPathCapability,
  assertLiteRuntimeDeploymentSlotPathProvisioned,
  closeLiteRuntimeDeploymentSlotPathAuthorityRoot,
  deriveLiteRuntimeDeploymentSlotPathCapability,
  inspectLiteRuntimeDeploymentSlotPathAuthorityRoot,
  inspectLiteRuntimeDeploymentSlotPathCapability,
  LiteRuntimeDeploymentSlotPathAuthorityError,
  openLiteRuntimeDeploymentSlotPathAuthorityRoot,
  prepareLiteRuntimeDeploymentSlotPathForProvisioning,
  provisionLiteRuntimeDeploymentSlotPathAuthorityRoot,
  type LiteRuntimeDeploymentSlotPathAuthorityRootCapability,
  type LiteRuntimeDeploymentSlotPathCapability,
} from "../../src/store/lite-runtime-deployment-slot-path-authority.js";

type Fixture = Readonly<{
  rootPath: string;
  rootCapability: LiteRuntimeDeploymentSlotPathAuthorityRootCapability;
}>;

function createEmptyRoot(t: TestContext): string {
  const rootPath = realpathSync(mkdtempSync(join(tmpdir(), "aionis-slot-path-")));
  chmodSync(rootPath, 0o700);
  t.after(() => rmSync(rootPath, { recursive: true, force: true }));
  return rootPath;
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function createFixture(t: TestContext): Fixture {
  const rootPath = createEmptyRoot(t);
  const provisioned = provisionLiteRuntimeDeploymentSlotPathAuthorityRoot({
    rootPath,
    now: new Date("2026-07-18T01:02:03.004Z"),
  });
  const rootCapability = openLiteRuntimeDeploymentSlotPathAuthorityRoot({
    rootPath,
    expectedRootManifestSha256: provisioned.root_manifest_sha256,
  });
  t.after(() => {
    try {
      closeLiteRuntimeDeploymentSlotPathAuthorityRoot(rootCapability);
    } catch {
      // Tests may deliberately close or invalidate the capability first.
    }
  });
  return { rootPath, rootCapability };
}

test("root provisioning uses exactly 32 supplied random bytes and requires an empty root", async (t) => {
  await t.test("exact random bytes become the immutable root instance ID", (child) => {
    const rootPath = createEmptyRoot(child);
    const requestedSizes: number[] = [];
    const provisioned = provisionLiteRuntimeDeploymentSlotPathAuthorityRoot({
      rootPath,
      now: new Date("2026-07-18T01:02:03.004Z"),
      randomBytesFactory: (size) => {
        requestedSizes.push(size);
        return new Uint8Array(32).fill(0xab);
      },
    });
    assert.deepEqual(requestedSizes, [32]);
    assert.equal(provisioned.root_instance_id, "ab".repeat(32));
    assert.equal(Object.isFrozen(provisioned), true);
    assertPathAuthorityError(
      () => inspectLiteRuntimeDeploymentSlotPathAuthorityRoot(
        provisioned as unknown as
          LiteRuntimeDeploymentSlotPathAuthorityRootCapability,
      ),
      "lite_runtime_deployment_slot_path_authority_root_capability_invalid",
    );
  });

  await t.test("wrong random byte length fails before writing the manifest", (child) => {
    const rootPath = createEmptyRoot(child);
    assertPathAuthorityError(
      () => provisionLiteRuntimeDeploymentSlotPathAuthorityRoot({
        rootPath,
        randomBytesFactory: () => new Uint8Array(31),
      }),
      "lite_runtime_deployment_slot_path_authority_manifest_invalid",
    );
    assert.deepEqual(readdirSync(rootPath), []);
  });

  await t.test("pre-positioned root content requires explicit recovery", (child) => {
    const rootPath = createEmptyRoot(child);
    writeFileSync(join(rootPath, "prepositioned"), "untrusted", { mode: 0o600 });
    assertPathAuthorityError(
      () => provisionLiteRuntimeDeploymentSlotPathAuthorityRoot({ rootPath }),
      "lite_runtime_deployment_slot_path_authority_recovery_required",
    );
    assert.deepEqual(readdirSync(rootPath), ["prepositioned"]);
  });
});

function assertPathAuthorityError(
  action: () => unknown,
  expectedCode:
    LiteRuntimeDeploymentSlotPathAuthorityError["code"],
): LiteRuntimeDeploymentSlotPathAuthorityError {
  let caught: unknown;
  try {
    action();
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof LiteRuntimeDeploymentSlotPathAuthorityError);
  assert.equal(caught.code, expectedCode);
  return caught;
}

test("launcher root manifest reopens to the same deterministic slot mapping", (t) => {
  const fixture = createFixture(t);
  const rootInspection = inspectLiteRuntimeDeploymentSlotPathAuthorityRoot(
    fixture.rootCapability,
  );
  assert.equal(rootInspection.root_path, fixture.rootPath);
  assert.equal(rootInspection.root_realpath, fixture.rootPath);
  assert.match(rootInspection.root_instance_id, /^[0-9a-f]{64}$/u);
  assert.match(rootInspection.root_manifest_sha256, /^[0-9a-f]{64}$/u);
  assert.equal(rootInspection.path_layout, "sha256_sharded_v1");
  assert.equal(
    rootInspection.trusted_launcher_root_selection,
    "required_not_established",
  );
  assert.equal(
    rootInspection.filesystem_locking_verification,
    "required_not_established",
  );

  const slot = deriveLiteRuntimeDeploymentSlotPathCapability(
    fixture.rootCapability,
    "runtime-primary",
  );
  const first = inspectLiteRuntimeDeploymentSlotPathCapability(slot);
  assert.equal(first.root_instance_id, rootInspection.root_instance_id);
  assert.equal(first.root_manifest_sha256, rootInspection.root_manifest_sha256);
  assert.equal(first.deployment_slot, "runtime-primary");
  assert.match(first.slot_sha256, /^[0-9a-f]{64}$/u);
  assert.equal(
    first.authority_state_relative_path,
    `slots/v1/${first.slot_sha256.slice(0, 2)}/${first.slot_sha256}/state.sqlite`,
  );
  assert.equal(
    first.lease_carrier_relative_path,
    `${first.authority_state_relative_path}.lease`,
  );
  assert.equal(
    first.authority_state_path,
    join(fixture.rootPath, first.authority_state_relative_path),
  );
  assert.equal(first.lease_carrier_path, `${first.authority_state_path}.lease`);
  assert.equal(
    first.trusted_launcher_root_selection,
    "required_not_established",
  );
  assert.equal(first.slot_provisioning_recovery, "required_not_established");
  assert.equal(first.filesystem_locking_verification, "required_not_established");
  assert.equal(first.isolated_carrier_lock_process, "required_not_established");

  prepareLiteRuntimeDeploymentSlotPathForProvisioning(slot);
  assert.deepEqual(assertLiteRuntimeDeploymentSlotPathProvisioned(slot), first);
  closeLiteRuntimeDeploymentSlotPathAuthorityRoot(fixture.rootCapability);

  const reopenedRoot = openLiteRuntimeDeploymentSlotPathAuthorityRoot({
    rootPath: fixture.rootPath,
    expectedRootManifestSha256: rootInspection.root_manifest_sha256,
  });
  t.after(() => closeLiteRuntimeDeploymentSlotPathAuthorityRoot(reopenedRoot));
  const reopenedSlot = deriveLiteRuntimeDeploymentSlotPathCapability(
    reopenedRoot,
    "runtime-primary",
  );
  assert.deepEqual(inspectLiteRuntimeDeploymentSlotPathCapability(reopenedSlot), first);
});

test("exact UTF-8 slots map independently and path-like values cannot redirect the root", (t) => {
  const fixture = createFixture(t);
  const primary = inspectLiteRuntimeDeploymentSlotPathCapability(
    deriveLiteRuntimeDeploymentSlotPathCapability(
      fixture.rootCapability,
      "runtime-primary",
    ),
  );
  const secondary = inspectLiteRuntimeDeploymentSlotPathCapability(
    deriveLiteRuntimeDeploymentSlotPathCapability(
      fixture.rootCapability,
      "runtime-secondary",
    ),
  );
  const pathLike = inspectLiteRuntimeDeploymentSlotPathCapability(
    deriveLiteRuntimeDeploymentSlotPathCapability(
      fixture.rootCapability,
      "../../runtime-primary",
    ),
  );
  assert.notEqual(primary.slot_sha256, secondary.slot_sha256);
  assert.notEqual(primary.slot_path_mapping_sha256, secondary.slot_path_mapping_sha256);
  assert.notEqual(primary.authority_state_path, secondary.authority_state_path);
  assert.ok(pathLike.authority_state_path.startsWith(`${fixture.rootPath}/slots/v1/`));
  assert.equal(pathLike.authority_state_relative_path.includes(".."), false);
  assert.equal(pathLike.authority_state_relative_path.includes("runtime-primary"), false);
});

test("slot validation rejects empty, padded, control, invalid UTF-8, and oversized identities", (t) => {
  const fixture = createFixture(t);
  for (const invalid of [
    "",
    " padded",
    "padded ",
    "line\nbreak",
    "nul\0byte",
    "\ud800",
    "x".repeat(257),
    "界".repeat(86),
  ]) {
    assertPathAuthorityError(
      () => deriveLiteRuntimeDeploymentSlotPathCapability(
        fixture.rootCapability,
        invalid,
      ),
      "lite_runtime_deployment_slot_path_authority_slot_invalid",
    );
  }
});

test("root and slot capabilities are WeakMap-backed and closed roots revoke derived slots", (t) => {
  const fixture = createFixture(t);
  const slot = deriveLiteRuntimeDeploymentSlotPathCapability(
    fixture.rootCapability,
    "runtime-primary",
  );
  const fakeRoot = Object.freeze({}) as LiteRuntimeDeploymentSlotPathAuthorityRootCapability;
  const fakeSlot = Object.freeze({}) as LiteRuntimeDeploymentSlotPathCapability;
  assertPathAuthorityError(
    () => inspectLiteRuntimeDeploymentSlotPathAuthorityRoot(fakeRoot),
    "lite_runtime_deployment_slot_path_authority_root_capability_invalid",
  );
  assertPathAuthorityError(
    () => assertLiteRuntimeDeploymentSlotPathCapability(fakeSlot),
    "lite_runtime_deployment_slot_path_authority_slot_capability_invalid",
  );
  closeLiteRuntimeDeploymentSlotPathAuthorityRoot(fixture.rootCapability);
  assertPathAuthorityError(
    () => inspectLiteRuntimeDeploymentSlotPathAuthorityRoot(fixture.rootCapability),
    "lite_runtime_deployment_slot_path_authority_root_capability_closed",
  );
  assertPathAuthorityError(
    () => inspectLiteRuntimeDeploymentSlotPathCapability(slot),
    "lite_runtime_deployment_slot_path_authority_root_capability_closed",
  );
});

test("root replacement is detected against the held directory descriptor", (t) => {
  const fixture = createFixture(t);
  const displaced = `${fixture.rootPath}.displaced`;
  t.after(() => rmSync(displaced, { recursive: true, force: true }));
  renameSync(fixture.rootPath, displaced);
  mkdirSync(fixture.rootPath, { mode: 0o700 });
  chmodSync(fixture.rootPath, 0o700);
  assertPathAuthorityError(
    () => inspectLiteRuntimeDeploymentSlotPathAuthorityRoot(fixture.rootCapability),
    "lite_runtime_deployment_slot_path_authority_identity_changed",
  );
});

test("root provisioning rejects a symbolic-link launcher root", (t) => {
  const rootPath = createEmptyRoot(t);
  const aliasPath = `${rootPath}.alias`;
  t.after(() => rmSync(aliasPath, { force: true }));
  symlinkSync(rootPath, aliasPath, "dir");
  assertPathAuthorityError(
    () => provisionLiteRuntimeDeploymentSlotPathAuthorityRoot({
      rootPath: aliasPath,
    }),
    "lite_runtime_deployment_slot_path_authority_filesystem_untrusted",
  );
  assert.deepEqual(readdirSync(rootPath), []);
});

test("manifest digest, canonical bytes, physical identity, and mode are all pinned", async (t) => {
  await t.test("wrong launcher digest is rejected", (child) => {
    const fixture = createFixture(child);
    assertPathAuthorityError(
      () => openLiteRuntimeDeploymentSlotPathAuthorityRoot({
        rootPath: fixture.rootPath,
        expectedRootManifestSha256: "0".repeat(64),
      }),
      "lite_runtime_deployment_slot_path_authority_manifest_digest_mismatch",
    );
  });

  await t.test("non-canonical bytes fail even when their digest is expected", (child) => {
    const fixture = createFixture(child);
    const inspection = inspectLiteRuntimeDeploymentSlotPathAuthorityRoot(
      fixture.rootCapability,
    );
    const canonical = readFileSync(inspection.root_manifest_path, "utf8");
    const nonCanonical = `${canonical}\n`;
    writeFileSync(inspection.root_manifest_path, nonCanonical, { mode: 0o600 });
    assertPathAuthorityError(
      () => inspectLiteRuntimeDeploymentSlotPathAuthorityRoot(fixture.rootCapability),
      "lite_runtime_deployment_slot_path_authority_manifest_digest_mismatch",
    );
    assertPathAuthorityError(
      () => openLiteRuntimeDeploymentSlotPathAuthorityRoot({
        rootPath: fixture.rootPath,
        expectedRootManifestSha256: sha256(nonCanonical),
      }),
      "lite_runtime_deployment_slot_path_authority_manifest_invalid",
    );
  });

  await t.test("canonical extra keys are rejected", (child) => {
    const fixture = createFixture(child);
    const inspection = inspectLiteRuntimeDeploymentSlotPathAuthorityRoot(
      fixture.rootCapability,
    );
    const parsed = JSON.parse(
      readFileSync(inspection.root_manifest_path, "utf8"),
    ) as Record<string, unknown>;
    const withExtraKey = stableStringify({ ...parsed, unexpected: true });
    writeFileSync(inspection.root_manifest_path, withExtraKey, { mode: 0o600 });
    assertPathAuthorityError(
      () => openLiteRuntimeDeploymentSlotPathAuthorityRoot({
        rootPath: fixture.rootPath,
        expectedRootManifestSha256: sha256(withExtraKey),
      }),
      "lite_runtime_deployment_slot_path_authority_manifest_invalid",
    );
  });

  await t.test("invalid canonical-looking dates return the stable manifest error", (child) => {
    const fixture = createFixture(child);
    const inspection = inspectLiteRuntimeDeploymentSlotPathAuthorityRoot(
      fixture.rootCapability,
    );
    const parsed = JSON.parse(
      readFileSync(inspection.root_manifest_path, "utf8"),
    ) as Record<string, unknown>;
    const invalidDate = stableStringify({
      ...parsed,
      created_at: "9999-99-99T99:99:99.999Z",
    });
    writeFileSync(inspection.root_manifest_path, invalidDate, { mode: 0o600 });
    assertPathAuthorityError(
      () => openLiteRuntimeDeploymentSlotPathAuthorityRoot({
        rootPath: fixture.rootPath,
        expectedRootManifestSha256: sha256(invalidDate),
      }),
      "lite_runtime_deployment_slot_path_authority_manifest_invalid",
    );
  });

  await t.test("manifest replacement with identical bytes changes physical identity", (child) => {
    const fixture = createFixture(child);
    const inspection = inspectLiteRuntimeDeploymentSlotPathAuthorityRoot(
      fixture.rootCapability,
    );
    const bytes = readFileSync(inspection.root_manifest_path);
    const displacedManifest = `${inspection.root_manifest_path}.displaced`;
    renameSync(inspection.root_manifest_path, displacedManifest);
    writeFileSync(inspection.root_manifest_path, bytes, { mode: 0o600 });
    chmodSync(inspection.root_manifest_path, 0o600);
    assertPathAuthorityError(
      () => inspectLiteRuntimeDeploymentSlotPathAuthorityRoot(fixture.rootCapability),
      "lite_runtime_deployment_slot_path_authority_identity_changed",
    );
  });

  await t.test("manifest and root mode changes fail closed", (child) => {
    const fixture = createFixture(child);
    const inspection = inspectLiteRuntimeDeploymentSlotPathAuthorityRoot(
      fixture.rootCapability,
    );
    chmodSync(inspection.root_manifest_path, 0o640);
    assertPathAuthorityError(
      () => inspectLiteRuntimeDeploymentSlotPathAuthorityRoot(fixture.rootCapability),
      "lite_runtime_deployment_slot_path_authority_identity_changed",
    );
    chmodSync(inspection.root_manifest_path, 0o600);
    chmodSync(fixture.rootPath, 0o750);
    assertPathAuthorityError(
      () => inspectLiteRuntimeDeploymentSlotPathAuthorityRoot(fixture.rootCapability),
      "lite_runtime_deployment_slot_path_authority_identity_changed",
    );
  });
});

test("pre-existing slot directories, symlinks, and files always require recovery", async (t) => {
  for (const kind of ["directory", "symlink", "file"] as const) {
    await t.test(kind, (child) => {
      const fixture = createFixture(child);
      const slot = deriveLiteRuntimeDeploymentSlotPathCapability(
        fixture.rootCapability,
        `preexisting-${kind}`,
      );
      const inspection = inspectLiteRuntimeDeploymentSlotPathCapability(slot);
      mkdirSync(dirname(inspection.slot_directory_path), {
        recursive: true,
        mode: 0o700,
      });
      if (kind === "directory") {
        mkdirSync(inspection.slot_directory_path, { mode: 0o700 });
      } else if (kind === "symlink") {
        symlinkSync(fixture.rootPath, inspection.slot_directory_path, "dir");
      } else {
        writeFileSync(inspection.slot_directory_path, "attacker-prepositioned", {
          mode: 0o600,
        });
      }
      assertPathAuthorityError(
        () => prepareLiteRuntimeDeploymentSlotPathForProvisioning(slot),
        "lite_runtime_deployment_slot_path_authority_recovery_required",
      );
    });
  }
});

test("a second prepare for one slot cannot invent a sibling authority path", (t) => {
  const fixture = createFixture(t);
  const slot = deriveLiteRuntimeDeploymentSlotPathCapability(
    fixture.rootCapability,
    "runtime-primary",
  );
  const inspection = prepareLiteRuntimeDeploymentSlotPathForProvisioning(slot);
  const shard = dirname(inspection.slot_directory_path);
  assert.deepEqual(readdirSync(shard), [inspection.slot_sha256]);
  assertPathAuthorityError(
    () => prepareLiteRuntimeDeploymentSlotPathForProvisioning(slot),
    "lite_runtime_deployment_slot_path_authority_recovery_required",
  );
  assert.deepEqual(readdirSync(shard), [inspection.slot_sha256]);
  assert.deepEqual(assertLiteRuntimeDeploymentSlotPathProvisioned(slot), inspection);
});
