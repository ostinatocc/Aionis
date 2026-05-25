import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  AIONIS_KERNEL_PRODUCT_CLAIM,
  aionisKernelCapability,
} from "../../src/kernel/boundary.ts";
import {
  deriveControlledStateRaiseRuntimeApply,
} from "../../src/memory/learning-control-shared.ts";
import { runLearningControlSemanticPreview as runLearningControlSemanticPreviewFromRunner } from "../../src/memory/learning-control-operation-runner.ts";
import { buildLiteLearningControlModelClient } from "../../src/memory/learning-control-model-client-factory.ts";
import {
  buildFormPatternLearningControlReviewProvider,
  buildPromoteMemoryLearningControlReviewProvider,
} from "../../src/memory/learning-control-provider-factory.ts";
import {
  createStaticFormPatternLearningControlReviewProvider,
  createStaticPromoteMemoryLearningControlReviewProvider,
} from "../../src/memory/learning-control-provider-static.ts";
import {
  createModelBackedFormPatternLearningControlReviewProvider,
  createModelBackedPromoteMemoryLearningControlReviewProvider,
} from "../../src/memory/learning-control-provider-model.ts";
import {
  createBuiltinFormPatternLearningControlModelClient,
  createBuiltinPromoteMemoryLearningControlModelClient,
} from "../../src/memory/learning-control-model-client-builtin.ts";
import {
  createHttpFormPatternLearningControlModelClient,
  createHttpPromoteMemoryLearningControlModelClient,
} from "../../src/memory/learning-control-model-client-http.ts";

const repoRoot = path.resolve(import.meta.dirname, "../..");

function walkFiles(dir: string): string[] {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  return entries.flatMap((entry) => {
    const file = path.join(dir, entry.name);
    return entry.isDirectory() ? walkFiles(file) : [file];
  });
}

test("focused boundary exposes learning control without platform control scope", () => {
  const learningControl = aionisKernelCapability("learning_control");

  assert.equal(AIONIS_KERNEL_PRODUCT_CLAIM.endsWith("_learning_control"), true);
  assert.equal(learningControl.display_name, "Learning Control");
  assert.ok(learningControl.owns.includes("authority_gate"));
  assert.ok(learningControl.owns.includes("learning_lifecycle_control"));
  assert.ok(learningControl.must_not_own.includes("admin_control_plane"));
  assert.ok(learningControl.must_not_own.includes("cloud_platform_control"));
});

test("learning control preview runner is the canonical generic review path", async () => {
  const preview = await runLearningControlSemanticPreviewFromRunner({
    buildPacket: () => ({ operation: "promote_memory" }),
    reviewResult: null,
    resolveReviewResult: () => ({ disposition: "recommend" }),
    evaluateAdmissibility: ({ review }) => ({ accepted: review.disposition === "recommend" }),
    derivePolicyEffect: ({ admissibility }) => ({ applies: admissibility?.accepted === true }),
    buildDecisionTrace: ({ policyEffect }) => ({ policy_effect_applies: policyEffect.applies }),
  });

  assert.deepEqual(preview.review_packet, { operation: "promote_memory" });
  assert.deepEqual(preview.review_result, { disposition: "recommend" });
  assert.deepEqual(preview.admissibility, { accepted: true });
  assert.deepEqual(preview.policy_effect, { applies: true });
  assert.deepEqual(preview.decision_trace, { policy_effect_applies: true });
});

test("controlled state runtime apply helper is the canonical promotion gate", () => {
  const controlled = deriveControlledStateRaiseRuntimeApply({
    policyEffect: { applies: true },
    effectiveState: "stable",
    appliedState: "stable",
  });

  assert.deepEqual(controlled, {
    runtimeApplyRequested: true,
    controlledOverrideState: "stable",
  });
});

test("focused runtime source has no stale learning-control boundary names", () => {
  const staleControlToken = "govern" + "ance";
  const staleControlledToken = "govern" + "ed";
  const files = [
    ...walkFiles(path.join(repoRoot, "src")),
    ...walkFiles(path.join(repoRoot, "packages/full-sdk/src")),
  ].filter((file) => file.endsWith(".ts") || file.endsWith(".js") || file.endsWith(".mjs"));

  for (const file of files) {
    const relative = path.relative(repoRoot, file);
    const content = fs.readFileSync(file, "utf8");
    assert.equal(relative.includes(staleControlToken), false, `${relative} path should not use stale control vocabulary`);
    assert.equal(relative.includes(staleControlledToken), false, `${relative} path should not use stale controlled vocabulary`);
    assert.equal(content.includes(staleControlToken), false, `${relative} content should not use stale control vocabulary`);
    assert.equal(content.includes(staleControlledToken), false, `${relative} content should not use stale controlled vocabulary`);
  }
});

test("learning control model client and provider factories are canonical", async () => {
  const modelClient = buildLiteLearningControlModelClient({
    formPattern: {
      mode: "custom",
    },
  }, {
    modelClientFactory: () => ({
      reviewFormPattern: () => ({
        review_version: "form_pattern_semantic_review_v1",
        adjudication: {
          operation: "form_pattern",
          disposition: "recommend",
          target_kind: "pattern",
          target_level: "L3",
          reason: "custom learning-control provider",
          confidence: 0.91,
        },
      }),
    }),
  });

  assert.equal(typeof modelClient.reviewFormPattern, "function");

  const formPatternProvider = buildFormPatternLearningControlReviewProvider({
    modelClientMode: "custom",
    modelClientFactory: () => modelClient,
  });
  assert.ok(formPatternProvider);
  const formPatternReview = await formPatternProvider.resolveReviewResult({
    reviewPacket: { deterministic_gate: { gate_satisfied: true } },
    suppliedReviewResult: null,
  });
  assert.equal(formPatternReview?.adjudication.reason, "custom learning-control provider");

  const promoteProvider = buildPromoteMemoryLearningControlReviewProvider({
    modelClientMode: "off",
    staticEnabled: true,
  });
  assert.ok(promoteProvider);
  const promoteReview = await promoteProvider.resolveReviewResult({
    reviewPacket: {
      deterministic_gate: { gate_satisfied: true },
      requested_target_kind: "workflow",
      requested_target_level: "L2",
      candidate_examples: [{ workflow_signature: "export-repair" }],
    },
    suppliedReviewResult: null,
  });
  assert.equal(promoteReview?.adjudication.operation, "promote_memory");
});

test("learning control concrete providers and model clients are canonical", async () => {
  const staticFormProvider = createStaticFormPatternLearningControlReviewProvider();
  const staticPromoteProvider = createStaticPromoteMemoryLearningControlReviewProvider();
  assert.equal(typeof staticFormProvider.resolveReviewResult, "function");
  assert.equal(typeof staticPromoteProvider.resolveReviewResult, "function");

  const modelBackedFormProvider = createModelBackedFormPatternLearningControlReviewProvider({
    modelClient: {
      reviewFormPattern: () => ({
        review_version: "form_pattern_semantic_review_v1",
        adjudication: {
          operation: "form_pattern",
          disposition: "recommend",
          target_kind: "pattern",
          target_level: "L3",
          reason: "model-backed learning-control provider",
          confidence: 0.9,
        },
      }),
    },
  });
  const modelBackedPromoteProvider = createModelBackedPromoteMemoryLearningControlReviewProvider({
    modelClient: {
      reviewPromoteMemory: () => ({
        review_version: "promote_memory_semantic_review_v1",
        adjudication: {
          operation: "promote_memory",
          disposition: "recommend",
          target_kind: "workflow",
          target_level: "L2",
          reason: "model-backed learning-control provider",
          confidence: 0.9,
          strategic_value: "high",
        },
      }),
    },
  });
  assert.equal(typeof modelBackedFormProvider?.resolveReviewResult, "function");
  assert.equal(typeof modelBackedPromoteProvider?.resolveReviewResult, "function");

  assert.equal(typeof createBuiltinFormPatternLearningControlModelClient().reviewFormPattern, "function");
  assert.equal(typeof createBuiltinPromoteMemoryLearningControlModelClient().reviewPromoteMemory, "function");

  const httpFormClient = createHttpFormPatternLearningControlModelClient({
    baseUrl: "https://model.invalid",
    apiKey: "test",
    model: "test",
    timeoutMs: 1,
    maxTokens: 32,
    temperature: 0,
  });
  const httpPromoteClient = createHttpPromoteMemoryLearningControlModelClient({
    baseUrl: "https://model.invalid",
    apiKey: "test",
    model: "test",
    timeoutMs: 1,
    maxTokens: 32,
    temperature: 0,
  });
  assert.equal(typeof httpFormClient.reviewFormPattern, "function");
  assert.equal(typeof httpPromoteClient.reviewPromoteMemory, "function");
});

test("learning control http prompt contract owns model review language", () => {
  const contract = fs.readFileSync(
    path.join(repoRoot, "src/memory/learning-control-model-client-http-contract.ts"),
    "utf8",
  );

  assert.ok(contract.includes("LEARNING_CONTROL_HTTP_OPENAI_TRANSPORT_CONTRACT_VERSION"));
  assert.ok(contract.includes("internal learning-control reviewer"));
  assert.equal(contract.includes("GOVERN" + "ANCE_HTTP_"), false);
  assert.equal(contract.includes("internal learning_control reviewer"), false);
});

test("form-pattern and promote-memory learning-control files own semantic review implementation", () => {
  const formPattern = fs.readFileSync(
    path.join(repoRoot, "src/memory/learning-control-form-pattern.ts"),
    "utf8",
  );
  const formPatternShared = fs.readFileSync(
    path.join(repoRoot, "src/memory/learning-control-form-pattern-shared.ts"),
    "utf8",
  );
  const promoteMemory = fs.readFileSync(
    path.join(repoRoot, "src/memory/learning-control-promote-memory.ts"),
    "utf8",
  );
  const promoteMemoryShared = fs.readFileSync(
    path.join(repoRoot, "src/memory/learning-control-promote-memory-shared.ts"),
    "utf8",
  );

  assert.ok(formPattern.includes("deriveFormPatternLearningControlPolicyEffect"));
  assert.ok(formPattern.includes("target_kind !== \"pattern\""));
  assert.ok(formPatternShared.includes("runFormPatternLearningControlPreview"));
  assert.ok(promoteMemory.includes("PromoteMemoryLearningControlCandidateExample"));
  assert.ok(promoteMemoryShared.includes("runPromoteMemoryLearningControlPreview"));
});
