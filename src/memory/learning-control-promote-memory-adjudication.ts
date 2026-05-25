import type {
  MemoryPromoteSemanticReviewPacket,
  MemoryPromoteSemanticReviewResult,
} from "./schemas.js";

function hasWorkflowSignature(packet: MemoryPromoteSemanticReviewPacket): boolean {
  return packet.candidate_examples.some((example) =>
    typeof example.workflow_signature === "string" && example.workflow_signature.trim().length > 0
  );
}

export function resolveBuiltinPromoteMemoryLearningControlReview(args: {
  reviewPacket: MemoryPromoteSemanticReviewPacket;
  suppliedReviewResult: MemoryPromoteSemanticReviewResult | null;
  confidence?: number;
  reason?: string;
}): MemoryPromoteSemanticReviewResult | null {
  if (args.suppliedReviewResult) {
    return args.suppliedReviewResult;
  }
  if (!args.reviewPacket.deterministic_gate.gate_satisfied) {
    return null;
  }
  if (
    args.reviewPacket.requested_target_kind !== "workflow"
    || args.reviewPacket.requested_target_level !== "L2"
  ) {
    return null;
  }
  if (!hasWorkflowSignature(args.reviewPacket)) {
    return null;
  }

  return {
    review_version: "promote_memory_semantic_review_v1",
    adjudication: {
      operation: "promote_memory",
      disposition: "recommend",
      target_kind: "workflow",
      target_level: "L2",
      reason: args.reason ?? "builtin adjudicator found workflow-signature evidence",
      confidence: args.confidence ?? 0.84,
      strategic_value: "high",
    },
  };
}
