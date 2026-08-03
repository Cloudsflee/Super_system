export class ProtocolValidationError extends Error {
  constructor(protocol, issues) {
    const normalized = issues.map((issue) => {
      const path =
        issue.code === 'unrecognized_keys' && Array.isArray(issue.keys) && issue.keys.length
          ? [...issue.path, issue.keys[0]]
          : issue.path;
      return {
        path: pathToJsonPointer(path),
        code: String(issue.code || 'invalid'),
        message: String(issue.message || 'invalid_value')
      };
    });
    super(`${protocol}_invalid`);
    this.name = 'ProtocolValidationError';
    this.code = 'execution_protocol_invalid';
    this.status = 400;
    this.payload = { error: this.code, protocol, field_path: normalized[0]?.path || '', issues: normalized };
  }
}

export function parseProtocol(schema, value, protocol = 'execution_protocol') {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new ProtocolValidationError(protocol, parsed.error.issues);
  return parsed.data;
}

export function pathToJsonPointer(path) {
  if (!Array.isArray(path) || !path.length) return '';
  return `/${path.map((part) => String(part).replaceAll('~', '~0').replaceAll('/', '~1')).join('/')}`;
}
