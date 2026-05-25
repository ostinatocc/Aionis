import type {
  MemoryFormPatternSemanticReviewPacket,
  MemoryPromoteSemanticReviewPacket,
} from "./schemas.js";
import {
  MEMORY_FORM_PATTERN_SEMANTIC_REVIEW_VERSION,
  MEMORY_PROMOTE_SEMANTIC_REVIEW_VERSION,
} from "./schemas.js";

export const LEARNING_CONTROL_HTTP_OPENAI_TRANSPORT_CONTRACT_VERSION = "openai_chat_completions_v1";
export const LEARNING_CONTROL_HTTP_ANTHROPIC_TRANSPORT_CONTRACT_VERSION = "anthropic_messages_v1";
export const LEARNING_CONTROL_HTTP_PROMOTE_MEMORY_PROMPT_VERSION = "promote_memory_http_prompt_v3";
export const LEARNING_CONTROL_HTTP_FORM_PATTERN_PROMPT_VERSION = "form_pattern_http_prompt_v3";

type LearningControlHttpPromptContract<TPacket> = {
  transport_contract_version:
    | typeof LEARNING_CONTROL_HTTP_OPENAI_TRANSPORT_CONTRACT_VERSION
    | typeof LEARNING_CONTROL_HTTP_ANTHROPIC_TRANSPORT_CONTRACT_VERSION;
  prompt_version: string;
  system_prompt: string;
  user_payload: {
    transport_contract_version:
      | typeof LEARNING_CONTROL_HTTP_OPENAI_TRANSPORT_CONTRACT_VERSION
      | typeof LEARNING_CONTROL_HTTP_ANTHROPIC_TRANSPORT_CONTRACT_VERSION;
    prompt_version: string;
    operation: string;
    response_contract: {
      kind: "strict_json_or_null";
      review_version: string;
      schema_note: string;
    };
    review_packet: TPacket;
  };
};

export function buildPromoteMemoryHttpPromptContract(
  reviewPacket: MemoryPromoteSemanticReviewPacket,
): LearningControlHttpPromptContract<MemoryPromoteSemanticReviewPacket> {
  return {
    transport_contract_version: LEARNING_CONTROL_HTTP_OPENAI_TRANSPORT_CONTRACT_VERSION,
    prompt_version: LEARNING_CONTROL_HTTP_PROMOTE_MEMORY_PROMPT_VERSION,
    system_prompt:
      "You are an internal learning-control reviewer for Aionis execution-memory. "
      + "Return strict JSON only. Return either null or an object matching "
      + "promote_memory_semantic_review_v1 with adjudication fields: "
      + "operation, disposition, target_kind, target_level, reason, confidence, strategic_value. "
      + "Be conservative. If the packet does not justify recommendation, return null.",
    user_payload: {
      transport_contract_version: LEARNING_CONTROL_HTTP_OPENAI_TRANSPORT_CONTRACT_VERSION,
      prompt_version: LEARNING_CONTROL_HTTP_PROMOTE_MEMORY_PROMPT_VERSION,
      operation: "promote_memory",
      response_contract: {
        kind: "strict_json_or_null",
        review_version: MEMORY_PROMOTE_SEMANTIC_REVIEW_VERSION,
        schema_note:
          "Return null or a promote_memory semantic review object matching the current schema version. Do not wrap in markdown or prose.",
      },
      review_packet: reviewPacket,
    },
  };
}

export function buildFormPatternHttpPromptContract(
  reviewPacket: MemoryFormPatternSemanticReviewPacket,
): LearningControlHttpPromptContract<MemoryFormPatternSemanticReviewPacket> {
  return {
    transport_contract_version: LEARNING_CONTROL_HTTP_OPENAI_TRANSPORT_CONTRACT_VERSION,
    prompt_version: LEARNING_CONTROL_HTTP_FORM_PATTERN_PROMPT_VERSION,
    system_prompt:
      "You are an internal learning-control reviewer for Aionis execution-memory. "
      + "Return strict JSON only. Return either null or an object matching "
      + "form_pattern_semantic_review_v1 with adjudication fields: "
      + "operation, disposition, target_kind, target_level, reason, confidence. "
      + "Be conservative. If the packet does not justify recommendation, return null.",
    user_payload: {
      transport_contract_version: LEARNING_CONTROL_HTTP_OPENAI_TRANSPORT_CONTRACT_VERSION,
      prompt_version: LEARNING_CONTROL_HTTP_FORM_PATTERN_PROMPT_VERSION,
      operation: "form_pattern",
      response_contract: {
        kind: "strict_json_or_null",
        review_version: MEMORY_FORM_PATTERN_SEMANTIC_REVIEW_VERSION,
        schema_note:
          "Return null or a form_pattern semantic review object matching the current schema version. Do not wrap in markdown or prose.",
      },
      review_packet: reviewPacket,
    },
  };
}

export function buildPromoteMemoryAnthropicHttpPromptContract(
  reviewPacket: MemoryPromoteSemanticReviewPacket,
): LearningControlHttpPromptContract<MemoryPromoteSemanticReviewPacket> {
  return {
    transport_contract_version: LEARNING_CONTROL_HTTP_ANTHROPIC_TRANSPORT_CONTRACT_VERSION,
    prompt_version: LEARNING_CONTROL_HTTP_PROMOTE_MEMORY_PROMPT_VERSION,
    system_prompt:
      "You are an internal learning-control reviewer for Aionis execution-memory. "
      + "Return strict JSON only. "
      + "Return exactly one of: null OR "
      + "{\"review_version\":\"promote_memory_semantic_review_v1\",\"adjudication\":{\"operation\":\"promote_memory\",\"disposition\":\"recommend|reject|insufficient_evidence\",\"target_kind\":\"execution|workflow|pattern|decision|none\",\"target_level\":\"L1|L2|L3\" when required,\"reason\":\"short string\",\"confidence\":0.0,\"strategic_value\":\"low|medium|high\"}}. "
      + "confidence must be a JSON number between 0 and 1. "
      + "strategic_value must be exactly low, medium, or high when present. "
      + "Treat the deterministic gate as authoritative. "
      + "If requested_target_kind is workflow, requested_target_level is L2, deterministic_gate.gate_satisfied is true, "
      + "and at least one candidate example carries a non-empty workflow_signature, default to a recommend decision for target_kind workflow and target_level L2. "
      + "In that case, use strategic_value high and confidence at or above 0.85 unless the packet contains explicit contradictory evidence. "
      + "Do not invent extra semantic-diversity or novelty thresholds beyond the packet's deterministic gate. "
      + "Do not explain, do not wrap in markdown, do not emit prose before or after JSON. "
      + "If evidence is insufficient, return null or disposition insufficient_evidence.",
    user_payload: {
      transport_contract_version: LEARNING_CONTROL_HTTP_ANTHROPIC_TRANSPORT_CONTRACT_VERSION,
      prompt_version: LEARNING_CONTROL_HTTP_PROMOTE_MEMORY_PROMPT_VERSION,
      operation: "promote_memory",
      response_contract: {
        kind: "strict_json_or_null",
        review_version: MEMORY_PROMOTE_SEMANTIC_REVIEW_VERSION,
        schema_note:
          "Return null or a promote_memory semantic review object matching the current schema version. Do not wrap in markdown or prose.",
      },
      review_packet: reviewPacket,
    },
  };
}

export function buildFormPatternAnthropicHttpPromptContract(
  reviewPacket: MemoryFormPatternSemanticReviewPacket,
): LearningControlHttpPromptContract<MemoryFormPatternSemanticReviewPacket> {
  return {
    transport_contract_version: LEARNING_CONTROL_HTTP_ANTHROPIC_TRANSPORT_CONTRACT_VERSION,
    prompt_version: LEARNING_CONTROL_HTTP_FORM_PATTERN_PROMPT_VERSION,
    system_prompt:
      "You are an internal learning-control reviewer for Aionis execution-memory. "
      + "Return strict JSON only. "
      + "Return exactly one of: null OR "
      + "{\"review_version\":\"form_pattern_semantic_review_v1\",\"adjudication\":{\"operation\":\"form_pattern\",\"disposition\":\"recommend|reject|insufficient_evidence\",\"target_kind\":\"pattern|none\",\"target_level\":\"L1|L2|L3\" when required,\"reason\":\"short string\",\"confidence\":0.0}}. "
      + "confidence must be a JSON number between 0 and 1. "
      + "Treat the deterministic gate as authoritative. "
      + "If deterministic_gate.gate_satisfied is true, default to recommending target_kind pattern at target_level L3 with confidence at or above 0.85 unless the packet contains explicit contradictory evidence. "
      + "Do not invent extra semantic-diversity, novelty, or source-deduplication thresholds beyond source_count_satisfied and signature_present. "
      + "Do not explain, do not wrap in markdown, do not emit prose before or after JSON. "
      + "If evidence is insufficient, return null or disposition insufficient_evidence.",
    user_payload: {
      transport_contract_version: LEARNING_CONTROL_HTTP_ANTHROPIC_TRANSPORT_CONTRACT_VERSION,
      prompt_version: LEARNING_CONTROL_HTTP_FORM_PATTERN_PROMPT_VERSION,
      operation: "form_pattern",
      response_contract: {
        kind: "strict_json_or_null",
        review_version: MEMORY_FORM_PATTERN_SEMANTIC_REVIEW_VERSION,
        schema_note:
          "Return null or a form_pattern semantic review object matching the current schema version. Do not wrap in markdown or prose.",
      },
      review_packet: reviewPacket,
    },
  };
}
