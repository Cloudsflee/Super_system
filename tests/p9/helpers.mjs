import {
  close,
  closeServer,
  listen,
  open as openP8
} from '../p8/helpers.mjs';

export async function open(options = {}) {
  const { configOverrides = {}, ...runtimeOptions } = options;
  return openP8({
    config: {
      corsOrigins: ['http://127.0.0.1:5174'],
      ...configOverrides
    },
    runtimePhase: 9,
    ...runtimeOptions
  });
}

export { close, closeServer, listen };

export function sessionHeaders(proof, extra = {}) {
  return { cookie: `aiws_session=${encodeURIComponent(proof)}`, accept: 'application/json', ...extra };
}

export async function json(response) {
  return { response, body: await response.json() };
}
