export function defineModule(definition) {
  return Object.freeze({
    ...definition,
    dependencies: Object.freeze([...(definition.dependencies || [])]),
    sql_dependencies: Object.freeze([...(definition.sql_dependencies || [])]),
    tables: Object.freeze([...(definition.tables || [])]),
    commands: Object.freeze([...(definition.commands || [])]),
    events: Object.freeze([...(definition.events || [])])
  });
}
