import { AppError } from '../errors.mjs';

export class QueryRegistry {
  constructor(entries = []) {
    this.queries = new Map(entries);
  }

  register(name, handler) {
    this.queries.set(name, handler);
  }

  execute(name, input = {}, ctx = {}) {
    const handler = this.queries.get(name);
    if (!handler) throw new AppError('unknown_query', `unknown query: ${name}`, { status: 404 });
    return handler(input, ctx);
  }
}
