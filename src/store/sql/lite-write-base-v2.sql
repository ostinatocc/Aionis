    CREATE TABLE IF NOT EXISTS lite_memory_commits (
      id TEXT PRIMARY KEY,
      scope TEXT NOT NULL,
      parent_commit_id TEXT,
      input_sha256 TEXT NOT NULL,
      diff_json TEXT NOT NULL,
      actor TEXT NOT NULL,
      model_version TEXT,
      prompt_version TEXT,
      commit_hash TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_lite_memory_commits_scope_created
      ON lite_memory_commits(scope, created_at DESC, id DESC);

    CREATE TABLE IF NOT EXISTS lite_memory_nodes (
      id TEXT PRIMARY KEY,
      scope TEXT NOT NULL,
      client_id TEXT,
      type TEXT NOT NULL,
      tier TEXT NOT NULL,
      title TEXT,
      text_summary TEXT,
      slots_json TEXT NOT NULL,
      raw_ref TEXT,
      evidence_ref TEXT,
      embedding_vector_json TEXT,
      embedding_model TEXT,
      memory_lane TEXT NOT NULL,
      producer_agent_id TEXT,
      owner_agent_id TEXT,
      owner_team_id TEXT,
      embedding_status TEXT NOT NULL,
      embedding_last_error TEXT,
      salience REAL NOT NULL,
      importance REAL NOT NULL,
      confidence REAL NOT NULL,
      redaction_version INTEGER NOT NULL,
      commit_id TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_lite_memory_nodes_scope ON lite_memory_nodes(scope);
    CREATE INDEX IF NOT EXISTS idx_lite_memory_nodes_scope_created ON lite_memory_nodes(scope, created_at DESC, id DESC);
    CREATE INDEX IF NOT EXISTS idx_lite_memory_nodes_scope_commit ON lite_memory_nodes(scope, commit_id);
    CREATE INDEX IF NOT EXISTS idx_lite_memory_nodes_scope_status ON lite_memory_nodes(scope, embedding_status);
    CREATE INDEX IF NOT EXISTS idx_lite_memory_nodes_scope_recall_stage1
      ON lite_memory_nodes(scope, tier, embedding_status, type, salience DESC, confidence DESC, created_at DESC, id DESC);
    CREATE INDEX IF NOT EXISTS idx_lite_memory_nodes_scope_type_created ON lite_memory_nodes(scope, type, created_at DESC, id DESC);
    CREATE INDEX IF NOT EXISTS idx_lite_memory_nodes_scope_client ON lite_memory_nodes(scope, client_id);
    CREATE INDEX IF NOT EXISTS idx_lite_memory_nodes_scope_type_client_created ON lite_memory_nodes(scope, type, client_id, created_at DESC, id DESC);
    CREATE INDEX IF NOT EXISTS idx_lite_memory_nodes_scope_type_summary_kind_created
      ON lite_memory_nodes(scope, type, json_extract(slots_json, '$.summary_kind'), created_at DESC, id DESC);
    CREATE INDEX IF NOT EXISTS idx_lite_memory_nodes_scope_type_summary_tool_created
      ON lite_memory_nodes(scope, type, json_extract(slots_json, '$.summary_kind'), json_extract(slots_json, '$.selected_tool'), created_at DESC, id DESC);

    CREATE TABLE IF NOT EXISTS lite_memory_execution_native_index (
      scope TEXT NOT NULL,
      node_id TEXT NOT NULL,
      execution_kind TEXT,
      anchor_kind TEXT,
      pattern_state TEXT,
      task_signature TEXT,
      task_family TEXT,
      error_signature TEXT,
      workflow_signature TEXT,
      pattern_signature TEXT,
      repo_signature TEXT,
      file_cluster TEXT,
      target_files_text TEXT,
      tool_chain_signature TEXT,
      failure_mode TEXT,
      verification_signature TEXT,
      acceptance_check_signature TEXT,
      compression_layer TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY(scope, node_id)
    );
    CREATE INDEX IF NOT EXISTS idx_lite_memory_execution_native_scope_created
      ON lite_memory_execution_native_index(scope, created_at DESC, node_id DESC);
    CREATE INDEX IF NOT EXISTS idx_lite_memory_execution_native_scope_kind_created
      ON lite_memory_execution_native_index(scope, execution_kind, created_at DESC, node_id DESC);
    CREATE INDEX IF NOT EXISTS idx_lite_memory_execution_native_scope_workflow_created
      ON lite_memory_execution_native_index(scope, workflow_signature, created_at DESC, node_id DESC);
    CREATE INDEX IF NOT EXISTS idx_lite_memory_execution_native_scope_task_created
      ON lite_memory_execution_native_index(scope, task_signature, created_at DESC, node_id DESC);
    CREATE INDEX IF NOT EXISTS idx_lite_memory_execution_native_scope_error_created
      ON lite_memory_execution_native_index(scope, error_signature, created_at DESC, node_id DESC);
    CREATE INDEX IF NOT EXISTS idx_lite_memory_execution_native_scope_pattern_created
      ON lite_memory_execution_native_index(scope, pattern_signature, created_at DESC, node_id DESC);
    CREATE INDEX IF NOT EXISTS idx_lite_memory_execution_native_scope_layer_created
      ON lite_memory_execution_native_index(scope, compression_layer, created_at DESC, node_id DESC);

    CREATE TABLE IF NOT EXISTS lite_memory_keyword_index (
      scope TEXT NOT NULL,
      node_id TEXT NOT NULL,
      title TEXT,
      text_summary TEXT,
      slots_text TEXT NOT NULL,
      searchable_text TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY(scope, node_id)
    );
    CREATE INDEX IF NOT EXISTS idx_lite_memory_keyword_scope_node
      ON lite_memory_keyword_index(scope, node_id);
    CREATE INDEX IF NOT EXISTS idx_lite_memory_keyword_scope_updated
      ON lite_memory_keyword_index(scope, updated_at DESC, node_id DESC);

    CREATE TABLE IF NOT EXISTS lite_memory_rule_defs (
      rule_node_id TEXT PRIMARY KEY,
      scope TEXT NOT NULL,
      state TEXT NOT NULL,
      if_json TEXT NOT NULL,
      then_json TEXT NOT NULL,
      exceptions_json TEXT NOT NULL,
      rule_scope TEXT NOT NULL,
      target_agent_id TEXT,
      target_team_id TEXT,
      positive_count INTEGER NOT NULL DEFAULT 0,
      negative_count INTEGER NOT NULL DEFAULT 0,
      commit_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_lite_memory_rule_defs_scope_created
      ON lite_memory_rule_defs(scope, created_at DESC, rule_node_id ASC);

    CREATE TABLE IF NOT EXISTS lite_memory_edges (
      id TEXT PRIMARY KEY,
      scope TEXT NOT NULL,
      type TEXT NOT NULL,
      src_id TEXT NOT NULL,
      dst_id TEXT NOT NULL,
      weight REAL NOT NULL,
      confidence REAL NOT NULL,
      decay_rate REAL NOT NULL,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      commit_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(scope, type, src_id, dst_id)
    );
    CREATE INDEX IF NOT EXISTS idx_lite_memory_edges_scope ON lite_memory_edges(scope);
    CREATE INDEX IF NOT EXISTS idx_lite_memory_edges_scope_commit ON lite_memory_edges(scope, commit_id);
    CREATE INDEX IF NOT EXISTS idx_lite_memory_edges_scope_src_weight_conf
      ON lite_memory_edges(scope, src_id, weight DESC, confidence DESC, id ASC);
    CREATE INDEX IF NOT EXISTS idx_lite_memory_edges_scope_dst_weight_conf
      ON lite_memory_edges(scope, dst_id, weight DESC, confidence DESC, id ASC);

    CREATE TABLE IF NOT EXISTS lite_memory_association_candidates (
      id TEXT PRIMARY KEY,
      scope TEXT NOT NULL,
      src_id TEXT NOT NULL,
      dst_id TEXT NOT NULL,
      relation_kind TEXT NOT NULL,
      status TEXT NOT NULL,
      score REAL NOT NULL,
      confidence REAL NOT NULL,
      feature_summary_json TEXT NOT NULL,
      evidence_json TEXT NOT NULL,
      source_commit_id TEXT,
      worker_run_id TEXT,
      promoted_edge_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(scope, src_id, dst_id, relation_kind)
    );
    CREATE INDEX IF NOT EXISTS idx_lite_memory_association_candidates_scope_src_score
      ON lite_memory_association_candidates(scope, src_id, score DESC, confidence DESC);
    CREATE INDEX IF NOT EXISTS idx_lite_memory_association_candidates_scope_dst_score
      ON lite_memory_association_candidates(scope, dst_id, score DESC, confidence DESC);

    CREATE TABLE IF NOT EXISTS lite_memory_outbox (
      row_id INTEGER PRIMARY KEY AUTOINCREMENT,
      scope TEXT NOT NULL,
      commit_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      job_key TEXT NOT NULL,
      payload_sha256 TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(scope, event_type, job_key)
    );
    CREATE INDEX IF NOT EXISTS idx_lite_memory_outbox_scope_commit ON lite_memory_outbox(scope, commit_id);
    CREATE INDEX IF NOT EXISTS idx_lite_memory_outbox_event_created ON lite_memory_outbox(event_type, created_at, row_id);

    CREATE TABLE IF NOT EXISTS lite_runtime_write_operations (
      tenant_id TEXT NOT NULL,
      scope TEXT NOT NULL,
      operation_kind TEXT NOT NULL,
      operation_id TEXT NOT NULL,
      request_sha256 TEXT NOT NULL,
      receipt_json TEXT NOT NULL,
      commit_id TEXT,
      created_at TEXT NOT NULL,
      PRIMARY KEY (tenant_id, scope, operation_kind, operation_id)
    );
    CREATE INDEX IF NOT EXISTS idx_lite_runtime_write_operations_created
      ON lite_runtime_write_operations(created_at DESC);

    CREATE TABLE IF NOT EXISTS lite_product_guide_receipts (
      tenant_id TEXT NOT NULL,
      scope TEXT NOT NULL,
      guide_trace_id TEXT NOT NULL,
      run_id TEXT,
      consumer_agent_id TEXT,
      consumer_team_id TEXT,
      query_sha256 TEXT NOT NULL,
      context_sha256 TEXT NOT NULL,
      ledger_sha256 TEXT NOT NULL,
      ledger_json TEXT NOT NULL,
      commit_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (tenant_id, scope, guide_trace_id)
    );
    CREATE INDEX IF NOT EXISTS idx_lite_product_guide_receipts_scope_created
      ON lite_product_guide_receipts(tenant_id, scope, created_at DESC, guide_trace_id DESC);
    CREATE INDEX IF NOT EXISTS idx_lite_product_guide_receipts_run_created
      ON lite_product_guide_receipts(tenant_id, scope, run_id, created_at DESC, guide_trace_id DESC);

    CREATE TABLE IF NOT EXISTS lite_memory_execution_decisions (
      id TEXT PRIMARY KEY,
      scope TEXT NOT NULL,
      decision_kind TEXT NOT NULL,
      run_id TEXT,
      selected_tool TEXT,
      candidates_json TEXT NOT NULL,
      context_sha256 TEXT NOT NULL,
      policy_sha256 TEXT NOT NULL,
      source_rule_ids_json TEXT NOT NULL,
      metadata_json TEXT NOT NULL,
      commit_id TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_lite_memory_execution_decisions_scope_created
      ON lite_memory_execution_decisions(scope, created_at DESC, id DESC);
    CREATE INDEX IF NOT EXISTS idx_lite_memory_execution_decisions_scope_run_created
      ON lite_memory_execution_decisions(scope, run_id, created_at DESC, id DESC);
    CREATE INDEX IF NOT EXISTS idx_lite_memory_execution_decisions_scope_tool_context_created
      ON lite_memory_execution_decisions(scope, selected_tool, context_sha256, created_at DESC, id DESC);

    CREATE TABLE IF NOT EXISTS lite_memory_rule_feedback (
      id TEXT PRIMARY KEY,
      scope TEXT NOT NULL,
      rule_node_id TEXT NOT NULL,
      run_id TEXT,
      outcome TEXT NOT NULL,
      note TEXT,
      source TEXT NOT NULL,
      decision_id TEXT,
      commit_id TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_lite_memory_rule_feedback_scope_run_created
      ON lite_memory_rule_feedback(scope, run_id, created_at DESC, id DESC);
    CREATE INDEX IF NOT EXISTS idx_lite_memory_rule_feedback_scope_rule_created
      ON lite_memory_rule_feedback(scope, rule_node_id, created_at DESC, id DESC);
