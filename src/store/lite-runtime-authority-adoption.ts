import stableStringify from "fast-json-stable-stringify";

import { sha256Hex } from "../util/crypto.js";
import { stableUuid } from "../util/uuid.js";
import { collectLiteRuntimeAuthorityAdoptionCandidatesV5 } from
  "./lite-memory-commit-integrity.js";
import { appendLiteRuntimeAppliedAuthorityInCurrentTransaction } from
  "./lite-runtime-applied-authority.js";
import {
  canonicalAuthorityAdoptionBindingSetSha256,
  canonicalAuthorityAdoptionIdentity,
  canonicalAuthorityAdoptionRowSha256,
  LITE_RUNTIME_AUTHORITY_ADOPTION_BINDING_TABLE_SQL,
  LITE_RUNTIME_AUTHORITY_ADOPTION_CANONICALIZATION_CONTRACT,
  LITE_RUNTIME_AUTHORITY_ADOPTION_MANIFEST_TABLE_SQL,
  LITE_RUNTIME_AUTHORITY_ADOPTION_TRIGGERS,
  type LiteRuntimeAuthorityAdoptionBinding,
  type LiteRuntimeAuthorityAdoptionManifest,
} from "./lite-runtime-authority-adoption-contract.js";
import type { LiteRuntimeAuthorityTransactionFence } from
  "./lite-runtime-authority-transaction-fence.js";
import type { SqliteDatabase } from "./sqlite.js";

export type LiteRuntimeAuthorityAdoptionMigrationResult = Readonly<{
  manifestCount: number;
  bindingCount: number;
  appendedCommitCount: number;
}>;

const PRE_SEAL_TRIGGERS = [
  "trg_lite_runtime_authority_adoption_manifest_no_update",
  "trg_lite_runtime_authority_adoption_manifest_no_delete",
  "trg_lite_runtime_authority_adoption_binding_no_update",
  "trg_lite_runtime_authority_adoption_binding_no_delete",
  "trg_lite_runtime_authority_adoption_binding_frozen_after_manifest",
] as const;

const SEAL_TRIGGERS = [
  "trg_lite_runtime_authority_adoption_manifest_sealed_after_v6",
  "trg_lite_runtime_authority_adoption_binding_sealed_after_v6",
] as const;

function exactManifestRow(value: unknown): LiteRuntimeAuthorityAdoptionManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("lite_runtime_authority_adoption_manifest_read_after_missing");
  }
  return value as LiteRuntimeAuthorityAdoptionManifest;
}

export function migrateLiteRuntimeAuthorityAdoptionV6(args: {
  db: SqliteDatabase;
  authorityFence: LiteRuntimeAuthorityTransactionFence;
  now?: Date;
}): LiteRuntimeAuthorityAdoptionMigrationResult {
  args.authorityFence.assertCurrent();
  const candidates = collectLiteRuntimeAuthorityAdoptionCandidatesV5(args.db);
  const createdAt = (args.now ?? new Date()).toISOString();
  if (new Date(createdAt).toISOString() !== createdAt) {
    throw new Error("lite_runtime_authority_adoption_created_at_invalid");
  }

  args.db.exec(`${LITE_RUNTIME_AUTHORITY_ADOPTION_MANIFEST_TABLE_SQL};`);
  args.db.exec(`${LITE_RUNTIME_AUTHORITY_ADOPTION_BINDING_TABLE_SQL};`);
  for (const name of PRE_SEAL_TRIGGERS) {
    args.db.exec(`${LITE_RUNTIME_AUTHORITY_ADOPTION_TRIGGERS[name]};`);
  }

  const byScope = new Map<string, typeof candidates[number][]>();
  for (const candidate of candidates) {
    const group = byScope.get(candidate.scope) ?? [];
    group.push(candidate);
    byScope.set(candidate.scope, group);
  }

  let manifestCount = 0;
  let bindingCount = 0;
  const scopes = [...byScope.keys()].sort((left, right) => Buffer.compare(
    Buffer.from(left, "utf8"),
    Buffer.from(right, "utf8"),
  ));
  for (const scope of scopes) {
    const scopeCandidates = byScope.get(scope)!;
    const provisional = scopeCandidates.map((candidate) => {
      const canonicalIdentity = canonicalAuthorityAdoptionIdentity(candidate.identity);
      return {
        scope,
        manifest_id: "",
        authority_table: candidate.authority_table,
        identity_json: canonicalIdentity.identity_json,
        identity_sha256: canonicalIdentity.identity_sha256,
        row_sha256: canonicalAuthorityAdoptionRowSha256(
          candidate.authority_table,
          candidate.row,
        ),
        adoption_kind: candidate.adoption_kind,
        created_at: createdAt,
      };
    });
    const bindingSetSha256 = canonicalAuthorityAdoptionBindingSetSha256(provisional);
    const manifestId = stableUuid(
      `lite:runtime-authority-adoption:v6:${scope}:${bindingSetSha256}`,
    );
    const bindings: LiteRuntimeAuthorityAdoptionBinding[] = provisional.map((binding) => ({
      ...binding,
      manifest_id: manifestId,
    }));
    for (const binding of bindings) {
      args.db.prepare(
        `INSERT INTO lite_runtime_authority_adoption_bindings
          (scope, manifest_id, authority_table, identity_json, identity_sha256,
           row_sha256, adoption_kind, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        binding.scope,
        binding.manifest_id,
        binding.authority_table,
        binding.identity_json,
        binding.identity_sha256,
        binding.row_sha256,
        binding.adoption_kind,
        binding.created_at,
      );
      bindingCount += 1;
    }

    const identity = { scope, manifest_id: manifestId };
    const canonicalAfter = {
      scope,
      manifest_id: manifestId,
      source_schema_version: 5,
      target_schema_version: 6,
      canonicalization_contract: LITE_RUNTIME_AUTHORITY_ADOPTION_CANONICALIZATION_CONTRACT,
      binding_count: bindings.length,
      binding_set_sha256: bindingSetSha256,
      commit_id: "$self",
      created_at: createdAt,
    };
    appendLiteRuntimeAppliedAuthorityInCurrentTransaction({
      db: args.db,
      authorityFence: args.authorityFence,
      scope,
      inputSha256: sha256Hex(stableStringify({
        contract: "aionis_runtime_authority_adoption_input_v1",
        ...canonicalAfter,
        commit_id: "$self",
      })),
      actor: "aionis-runtime-authority-adoption-v6",
      appliedAt: createdAt,
      authorityKind: "runtime_authority_adoption",
      mutations: [{
        table: "lite_runtime_authority_adoption_manifests",
        identity,
        operation: "insert",
        before: null,
        requested: {
          scope,
          source_schema_version: 5,
          target_schema_version: 6,
          binding_count: bindings.length,
          binding_set_sha256: bindingSetSha256,
        },
        after: canonicalAfter,
      }],
      apply: ({ commitId }) => {
        args.db.prepare(
          `INSERT INTO lite_runtime_authority_adoption_manifests
            (scope, manifest_id, source_schema_version, target_schema_version,
             canonicalization_contract, binding_count, binding_set_sha256,
             commit_id, created_at)
           VALUES (?, ?, 5, 6, ?, ?, ?, ?, ?)`,
        ).run(
          scope,
          manifestId,
          LITE_RUNTIME_AUTHORITY_ADOPTION_CANONICALIZATION_CONTRACT,
          bindings.length,
          bindingSetSha256,
          commitId,
          createdAt,
        );
        return exactManifestRow(args.db.prepare(
          `SELECT scope, manifest_id, source_schema_version, target_schema_version,
                  canonicalization_contract, binding_count, binding_set_sha256,
                  commit_id, created_at
           FROM lite_runtime_authority_adoption_manifests
           WHERE scope = ? AND manifest_id = ?`,
        ).get(scope, manifestId));
      },
      verify: ({ value }) => [{
        table: "lite_runtime_authority_adoption_manifests",
        identity,
        after: value,
      }],
    });
    manifestCount += 1;
  }

  // The final two triggers are unconditional seals. They are deliberately
  // installed only after the owned migration has written every manifest.
  for (const name of SEAL_TRIGGERS) {
    args.db.exec(`${LITE_RUNTIME_AUTHORITY_ADOPTION_TRIGGERS[name]};`);
  }
  args.authorityFence.assertCurrent();
  return {
    manifestCount,
    bindingCount,
    appendedCommitCount: manifestCount,
  };
}
