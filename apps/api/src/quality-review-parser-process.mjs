import { fork } from 'node:child_process';

export const QUALITY_REVIEW_PARSER_PROCESS_LIMITS = Object.freeze({
  maxOldGenerationSizeMb: 128,
  maxYoungGenerationSizeMb: 16,
  stackSizeMb: 4
});

const PARSER_MODULE = new URL('./quality-review-parser-worker.mjs', import.meta.url);

export function exchangeQualityReviewParser(input, { timeoutMs = 0, signal = null } = {}) {
  if (signal?.aborted) return Promise.reject(parserProcessFailure('quality_review_cancelled'));
  return new Promise((resolve, reject) => {
    const child = fork(PARSER_MODULE, [], {
      env: parserEnvironment(),
      execArgv: parserExecArgv(),
      serialization: 'advanced',
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      windowsHide: true
    });
    let settled = false,
      message,
      timer;
    const cleanup = () => {
        if (timer) clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        child.removeAllListeners();
      },
      settle = (callback, value) => {
        if (settled) return;
        settled = true;
        cleanup();
        callback(value);
      },
      terminateAndReject = (error) => {
        if (settled) return;
        settled = true;
        cleanup();
        void terminateParserProcess(child).then(() => reject(error));
      },
      abort = () => terminateAndReject(parserProcessFailure('quality_review_cancelled'));
    if (Number(timeoutMs) > 0)
      timer = setTimeout(() => {
        const error = parserProcessFailure('quality_review_parser_timeout');
        error.retryable = true;
        terminateAndReject(error);
      }, Number(timeoutMs));
    child.once('message', (value) => {
      message = value;
    });
    child.once('error', (error) => {
      const failure = parserProcessFailure(
        'quality_review_parser_process_failed',
        { cause: error?.code || error?.message || 'process_error' },
        error
      );
      failure.retryable = true;
      terminateAndReject(failure);
    });
    child.once('exit', (code, exitSignal) => {
      if (settled) return;
      if (code !== 0 || message === undefined) {
        const failure = parserProcessFailure(
          code === 0 ? 'quality_review_parser_process_no_result' : 'quality_review_parser_process_exited',
          { exit_code: code, signal: exitSignal || null }
        );
        failure.retryable = code !== 0;
        settle(reject, failure);
        return;
      }
      settle(resolve, message);
    });
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) return abort();
    child.send(input, (error) => {
      if (!error) return;
      const failure = parserProcessFailure(
        'quality_review_parser_process_send_failed',
        { cause: error?.code || error?.message || 'send_error' },
        error
      );
      failure.retryable = true;
      terminateAndReject(failure);
    });
  });
}

function parserEnvironment() {
  const allowed = [
      'HOME',
      'LANG',
      'LC_ALL',
      'LOCALAPPDATA',
      'NODE_ENV',
      'PATH',
      'SystemRoot',
      'TEMP',
      'TMP',
      'TMPDIR',
      'TZ',
      'USERPROFILE',
      'WINDIR'
    ],
    environment = {};
  for (const key of allowed) if (process.env[key] !== undefined) environment[key] = process.env[key];
  return environment;
}

function parserExecArgv() {
  return [
    `--max-old-space-size=${QUALITY_REVIEW_PARSER_PROCESS_LIMITS.maxOldGenerationSizeMb}`,
    `--max-semi-space-size=${QUALITY_REVIEW_PARSER_PROCESS_LIMITS.maxYoungGenerationSizeMb}`,
    `--stack-size=${QUALITY_REVIEW_PARSER_PROCESS_LIMITS.stackSizeMb * 1024}`
  ];
}

function terminateParserProcess(child) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, 2000),
      finish = () => {
        clearTimeout(timer);
        resolve();
      };
    timer.unref?.();
    child.once('exit', finish);
    if (!child.kill('SIGKILL')) finish();
  });
}

function parserProcessFailure(code, details = {}, cause = null) {
  const error = new Error(code, cause ? { cause } : undefined);
  error.code = code;
  error.details = details;
  return error;
}
