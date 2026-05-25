import {
  ExecutionStateV1Schema,
  type ExecutionStateV1,
} from "../execution/types.js";
import {
  ExecutionStateTransitionV1Schema,
  type ExecutionStateTransitionV1,
} from "../execution/transitions.js";

export const EXECUTION_SLOT_FIELD_NAMES = {
  resultSummary: "execution_result_summary",
  artifacts: "execution_artifacts",
  evidence: "execution_evidence",
  delegationRecords: "delegation_records_v1",
  contract: "execution_contract_v1",
  state: "execution_state_v1",
  packet: "execution_packet_v1",
  controlProfile: "control_profile_v1",
  transition: "execution_transition_v1",
  transitions: "execution_transitions_v1",
} as const;

export type ExecutionContinuitySlotFields = {
  execution_result_summary: unknown;
  execution_artifacts: unknown;
  execution_evidence: unknown;
  delegation_records_v1: unknown;
  execution_contract_v1: unknown;
  execution_state_v1: unknown;
  execution_packet_v1: unknown;
  control_profile_v1: unknown;
  execution_transitions_v1: unknown;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function readSlot(slots: Record<string, unknown> | null, key: string): unknown {
  return slots && key in slots ? slots[key] : undefined;
}

export function readExecutionStateSlot(slots: Record<string, unknown> | null): ExecutionStateV1 | null {
  const raw = readSlot(slots, EXECUTION_SLOT_FIELD_NAMES.state);
  return raw === undefined ? null : ExecutionStateV1Schema.parse(raw);
}

export function readExecutionTransitionSlot(slots: Record<string, unknown> | null): ExecutionStateTransitionV1 | null {
  const raw = readSlot(slots, EXECUTION_SLOT_FIELD_NAMES.transition);
  return raw === undefined ? null : ExecutionStateTransitionV1Schema.parse(raw);
}

export function readExecutionTransitionsSlot(slots: Record<string, unknown> | null): ExecutionStateTransitionV1[] | null {
  const raw = readSlot(slots, EXECUTION_SLOT_FIELD_NAMES.transitions);
  return Array.isArray(raw) ? raw.map((transition) => ExecutionStateTransitionV1Schema.parse(transition)) : null;
}

export function readExecutionContinuitySlotFields(
  slots: Record<string, unknown> | null,
): ExecutionContinuitySlotFields {
  return {
    execution_result_summary: readSlot(slots, EXECUTION_SLOT_FIELD_NAMES.resultSummary),
    execution_artifacts: readSlot(slots, EXECUTION_SLOT_FIELD_NAMES.artifacts),
    execution_evidence: readSlot(slots, EXECUTION_SLOT_FIELD_NAMES.evidence),
    delegation_records_v1: readSlot(slots, EXECUTION_SLOT_FIELD_NAMES.delegationRecords),
    execution_contract_v1: readSlot(slots, EXECUTION_SLOT_FIELD_NAMES.contract),
    execution_state_v1: readSlot(slots, EXECUTION_SLOT_FIELD_NAMES.state),
    execution_packet_v1: readSlot(slots, EXECUTION_SLOT_FIELD_NAMES.packet),
    control_profile_v1: readSlot(slots, EXECUTION_SLOT_FIELD_NAMES.controlProfile),
    execution_transitions_v1: readSlot(slots, EXECUTION_SLOT_FIELD_NAMES.transitions),
  };
}

export function collectExecutionWriteOverlaySlots(nodes: Iterable<{ slots?: unknown }>): {
  states: ExecutionStateV1[];
  transitions: ExecutionStateTransitionV1[];
} {
  const states: ExecutionStateV1[] = [];
  const transitions: ExecutionStateTransitionV1[] = [];
  for (const node of nodes) {
    const slots = asRecord(node.slots);
    const state = readExecutionStateSlot(slots);
    if (state) states.push(state);
    const transition = readExecutionTransitionSlot(slots);
    if (transition) transitions.push(transition);
  }
  return { states, transitions };
}
