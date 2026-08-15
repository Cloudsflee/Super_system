export class WorkflowRepository {
  constructor(db) { this.db = db; }

  draft(id) { return id ? this.db.get('SELECT * FROM workflow_drafts WHERE id=?', [id]) : null; }

  latest(projectId) {
    return this.db.get('SELECT * FROM workflow_revisions WHERE project_id=? ORDER BY revision DESC LIMIT 1', [projectId]);
  }

  createDraftStatement({ id, projectId, timestamp }) {
    return {
      sql: `INSERT INTO workflow_drafts(
        id,project_id,revision,graph_json,status,created_at,updated_at,source_brief_revision,source_brief_hash,
        hierarchy_mode,generation_status,critic_status,last_generation_id,applied_workflow_revision,layout_revision,draft_hash,draft_updated_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      params: [id, projectId, 1, '{}', 'draft', timestamp, timestamp, 0, '', 'two_level', 'idle', 'not_run', null, 0, 0,
        '44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a', timestamp]
    };
  }

  updateDraftBriefStatement({ projectId, revision, contentHash, timestamp }) {
    return {
      sql: "UPDATE workflow_drafts SET source_brief_revision=?,source_brief_hash=?,updated_at=? WHERE project_id=? AND status='draft'",
      params: [revision, contentHash, timestamp, projectId]
    };
  }
}
