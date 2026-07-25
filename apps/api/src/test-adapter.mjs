export function testAdapter(body = {}, query = {}) {
  return (
    process.env.NODE_ENV === 'test' &&
    (body.adapter === 'test' || query.adapter === 'test' || process.env.AIWS_TEST_ADAPTERS === '1')
  );
}
