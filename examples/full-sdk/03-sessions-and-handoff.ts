import { randomUUID } from "node:crypto";
import { createExampleClient, createScope, DEFAULT_TENANT_ID, isMain, printHeading, printJson, printStep, runExample } from "./shared.js";

async function main() {
  const aionis = createExampleClient();
  const scope = createScope("full-sdk-session");
  const sessionId = `session-${randomUUID()}`;

  printHeading("Full SDK Sessions And Handoff");
  printStep(`scope=${scope}`);
  printStep(`sessionId=${sessionId}`);

  const session = await aionis.memory.sessions.create({
    tenant_id: DEFAULT_TENANT_ID,
    scope,
    actor: "full-sdk-example",
    session_id: sessionId,
    title: "Runtime repair working session",
    input_text: "Create a runtime repair working session for private operator flow testing.",
    memory_lane: "shared",
  });
  printJson("session_create", session);

  const event = await aionis.memory.sessions.writeEvent({
    tenant_id: DEFAULT_TENANT_ID,
    scope,
    actor: "full-sdk-example",
    session_id: sessionId,
    title: "Observed replay repair success",
    input_text: "Validated replay repair success and captured the recovery outcome.",
    memory_lane: "shared",
  });
  printJson("session_event_write", event);

  const sessions = await aionis.memory.sessions.list({
    tenant_id: DEFAULT_TENANT_ID,
    scope,
    include_meta: true,
    limit: 10,
  });
  printJson("sessions_list", sessions);

  const events = await aionis.memory.sessions.events({
    tenant_id: DEFAULT_TENANT_ID,
    scope,
    session_id: sessionId,
    include_meta: true,
    include_slots_preview: true,
    limit: 10,
  });
  printJson("session_events", events);

  const handoff = await aionis.handoff.store({
    tenant_id: DEFAULT_TENANT_ID,
    scope,
    actor: "full-sdk-example",
    handoff_kind: "task_handoff",
    anchor: `handoff:${sessionId}`,
    summary: "Continue Aionis Core repair workflow",
    handoff_text: "Inspect replay state, review session events, then proceed with the next repair step.",
    target_files: ["src/routes/memory-replay-core.ts"],
    next_action: "Inspect the latest replay run and verify the repaired step sequence.",
    acceptance_checks: ["npm run -s test:lite"],
  });
  printJson("handoff_store", handoff);
}

if (isMain(import.meta.url)) {
  await runExample(main);
}
