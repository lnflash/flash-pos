/** Keep opt-in mint integrations inside explicitly selected loopback services. */
export function installLocalFetch(origins: string[]): () => void {
  const allowed = new Set(
    origins.map(value => {
      const url = new URL(value);
      if (
        url.protocol !== 'http:' ||
        !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
        url.username ||
        url.password ||
        url.pathname !== '/' ||
        url.search ||
        url.hash
      ) {
        throw new Error('local HTTP integration service required');
      }
      return url.origin;
    }),
  );
  const previous = global.fetch;
  const nodeFetch: typeof fetch = require('node-fetch');
  global.fetch = (async (input, init) => {
    const url = new URL(
      typeof input === 'string'
        ? input
        : input instanceof URL
        ? input.toString()
        : input.url,
    );
    if (!allowed.has(url.origin)) {
      throw new Error('local integration network boundary');
    }
    return nodeFetch(input, {...init, redirect: 'error'});
  }) as typeof fetch;
  return () => {
    global.fetch = previous;
  };
}
