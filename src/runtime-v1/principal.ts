import {
  canonicalContinuationSha256,
  type Sha256,
} from "../continuation/contract.js";

/** Stable identity shared by authenticated Runtime requests and offline authoring. */
export function continuationRuntimeV1PrincipalSha256(args: Readonly<{
  tenant_id: string;
  principal_kind: "trusted_host" | "operator";
  principal_id: string;
}>): Sha256 {
  return canonicalContinuationSha256({
    schema_version: "continuation_runtime_principal_v1",
    tenant_id: args.tenant_id,
    principal_kind: args.principal_kind,
    principal_id: args.principal_id,
    authentication: "bearer_sha256_v1",
  });
}
