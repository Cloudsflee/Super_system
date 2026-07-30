const DEFAULT_TIMEOUT_MS = 3_000;
const DEFAULT_POLL_MS = 25;

export async function waitForProjectionLeaseSettlement({
  readState,
  collectFailures,
  failureOptions,
  state,
  failures,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  pollMs = DEFAULT_POLL_MS
}) {
  const deadline = Date.now() + timeoutMs;
  let currentState = state,
    currentFailures = failures;
  while (currentFailures.length && currentFailures.every(activeLease) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, pollMs));
    currentState = await readState();
    currentFailures = collectFailures(currentState, failureOptions);
  }
  return { state: currentState, failures: currentFailures };
}

function activeLease(failure) {
  return failure.job?.status === 'running' && Date.parse(failure.job.lease?.expires_at || '') > Date.now();
}
