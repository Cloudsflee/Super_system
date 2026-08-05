# V2 Retrospective

V2 accumulated versioned services, migrations, compatibility facades, large in-memory state snapshots, a global context projector, standalone MCP infrastructure, team and Exchange concepts, terminal/host bridges, and broad document parsers. The number of runtime collections and release scripts made ownership and recovery difficult to demonstrate.

V3 treats Git history as the archive for source implementations. Runtime directories contain one implementation per domain. V2.3 state remains cold evidence and is not a compatibility input.

The final V2.3 cutover receipt was revoked by a new immutable receipt because its declared rollback image tag was absent and the observed runtime image identified a later working-tree build. The old receipt was not edited. After writes stopped, the source volume was fully hashed, copied to a cold evidence volume, compressed, restored to a temporary volume, and verified with matching manifests and SQLite integrity.

No generic V2-to-V3 migrator exists. The DesignSignal demonstration project is recreated through the public V3 API with sanitized content.
