export class RouteRegistry {
  constructor(definitions = []) {
    this.routes = definitions.map(compileRoute);
  }

  match(method, parts) {
    for (const route of this.routes) {
      if (route.method !== method || route.segments.length !== parts.length) continue;
      const params = {};
      let matched = true;
      for (let index = 0; index < route.segments.length; index += 1) {
        const segment = route.segments[index];
        if (segment.startsWith(':')) params[segment.slice(1)] = parts[index];
        else if (segment !== parts[index]) { matched = false; break; }
      }
      if (matched) return { ...route, params };
    }
    return null;
  }
}

function compileRoute(definition) {
  return Object.freeze({
    responseStatus: 200,
    ...definition,
    method: String(definition.method).toUpperCase(),
    segments: String(definition.path).split('/').filter(Boolean)
  });
}
