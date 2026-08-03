export function isQualityReviewRunRoute(route) {
  return (
    route.method === 'POST' &&
    /^\/(?:workflow-executions|quality-reviews)\/.+\/(?:quality-reviews|cancel)$/.test(route.pattern)
  );
}

export function isProjectRunRoute(route) {
  return (
    route.pattern.includes('/run') || /\/stages\/[^/]+\/replay$/.test(route.pattern) || isQualityReviewRunRoute(route)
  );
}
