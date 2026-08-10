export function defineModule(definition) {
  return Object.freeze({
    ...definition,
    dependencies: Object.freeze([...(definition.dependencies || [])]),
    tables: Object.freeze([...(definition.tables || [])]),
    commands: Object.freeze([...(definition.commands || [])]),
    events: Object.freeze([...(definition.events || [])])
  });
}
