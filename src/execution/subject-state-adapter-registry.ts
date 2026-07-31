import type {
  ExecutionSubjectV1,
  SubjectStateAdapter,
} from "./subject-state-adapter.js";
import {
  ExecutionSubjectV1Schema,
  SubjectCapabilityDescriptorV1Schema,
  subjectCapabilityDescriptorDigest,
  subjectCapabilityDescriptorRef,
} from "./subject-state-adapter.js";

export class SubjectStateAdapterRegistryError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = "SubjectStateAdapterRegistryError";
    this.code = code;
  }
}

function fail(code: string): never {
  throw new SubjectStateAdapterRegistryError(code);
}

function key(adapterId: string, adapterVersion: string): string {
  return `${adapterId}\u0000${adapterVersion}`;
}

function canonicalAdapter(
  adapter: SubjectStateAdapter,
): SubjectStateAdapter {
  if (
    adapter === null
    || typeof adapter !== "object"
    || typeof adapter.adapterId !== "string"
    || adapter.adapterId.length === 0
    || adapter.adapterId !== adapter.adapterId.trim()
    || typeof adapter.adapterVersion !== "string"
    || adapter.adapterVersion.length === 0
    || adapter.adapterVersion !== adapter.adapterVersion.trim()
    || typeof adapter.supports !== "function"
    || typeof adapter.identify !== "function"
    || typeof adapter.capture !== "function"
    || typeof adapter.diff !== "function"
    || typeof adapter.restoreSnapshot !== "function"
    || typeof adapter.materializeForVerifier !== "function"
  ) {
    return fail("subject_state_adapter_invalid");
  }
  const capabilities = SubjectCapabilityDescriptorV1Schema.parse(
    adapter.capabilities,
  );
  const descriptorSha256 = subjectCapabilityDescriptorDigest(capabilities);
  if (
    subjectCapabilityDescriptorRef(descriptorSha256)
      !== subjectCapabilityDescriptorRef(
        subjectCapabilityDescriptorDigest(adapter.capabilities),
      )
  ) {
    return fail("subject_state_adapter_capability_descriptor_unstable");
  }
  return adapter;
}

export type SubjectStateAdapterRegistry = Readonly<{
  resolve(
    adapterId: string,
    adapterVersion: string,
  ): SubjectStateAdapter | null;
  resolveForKind(subjectKind: string): SubjectStateAdapter;
  assertSubject(subject: ExecutionSubjectV1): SubjectStateAdapter;
  list(): readonly SubjectStateAdapter[];
}>;

export function createSubjectStateAdapterRegistry(
  input: readonly SubjectStateAdapter[],
): SubjectStateAdapterRegistry {
  const entries = new Map<string, SubjectStateAdapter>();
  const ordered = input.map(canonicalAdapter);
  for (const adapter of ordered) {
    const adapterKey = key(adapter.adapterId, adapter.adapterVersion);
    if (entries.has(adapterKey)) {
      return fail("subject_state_adapter_duplicate");
    }
    entries.set(adapterKey, adapter);
  }
  if (entries.size === 0) {
    return fail("subject_state_adapter_registry_empty");
  }

  return Object.freeze({
    resolve(adapterId, adapterVersion) {
      return entries.get(key(adapterId, adapterVersion)) ?? null;
    },

    resolveForKind(subjectKind) {
      const matches = ordered.filter((adapter) =>
        adapter.supports(subjectKind)
      );
      if (matches.length === 0) {
        return fail("subject_state_adapter_kind_unsupported");
      }
      if (matches.length !== 1) {
        return fail("subject_state_adapter_kind_ambiguous");
      }
      return matches[0]!;
    },

    assertSubject(inputSubject) {
      const subject = ExecutionSubjectV1Schema.parse(inputSubject);
      const adapter = entries.get(
        key(subject.adapter_id, subject.adapter_version),
      );
      if (!adapter || !adapter.supports(subject.kind)) {
        return fail("subject_state_adapter_subject_unsupported");
      }
      const descriptorSha256 = subjectCapabilityDescriptorDigest(
        adapter.capabilities,
      );
      if (
        subject.capability_descriptor_sha256 !== descriptorSha256
        || subject.capability_descriptor_ref
          !== subjectCapabilityDescriptorRef(descriptorSha256)
      ) {
        return fail("subject_state_adapter_capability_mismatch");
      }
      return adapter;
    },

    list() {
      return Object.freeze([...ordered]);
    },
  });
}
