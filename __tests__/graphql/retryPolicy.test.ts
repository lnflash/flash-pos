import {ApolloLink, Observable, execute, gql} from '@apollo/client';
import {RetryLink} from '@apollo/client/link/retry';

import {
  NO_RETRY_CONTEXT,
  shouldRetryOperation,
} from '../../src/graphql/retryPolicy';

// The same RetryLink options as src/graphql/ApolloClient.ts, with no delay so
// the retries run immediately.
const retryLink = () =>
  new RetryLink({
    delay: {initial: 0, max: 0, jitter: false},
    attempts: {max: 5, retryIf: shouldRetryOperation},
  });

const MUTATION = gql`
  mutation Create {
    create
  }
`;

// A transport that always fails the way fetch does offline, counting sends.
const offlineTransport = () => {
  const sent = {count: 0};
  const link = new ApolloLink(
    () =>
      new Observable(observer => {
        sent.count += 1;
        observer.error(new TypeError('Network request failed'));
      }),
  );
  return {sent, link};
};

const run = (context?: Record<string, unknown>) => {
  const {sent, link} = offlineTransport();
  return new Promise<{count: number; error: unknown}>(resolve => {
    execute(ApolloLink.from([retryLink(), link]), {
      query: MUTATION,
      context,
    }).subscribe({
      next: () => {},
      error: error => resolve({count: sent.count, error}),
      complete: () => resolve({count: sent.count, error: undefined}),
    });
  });
};

describe('RetryLink policy (ENG-703)', () => {
  it('sends an operation with NO_RETRY_CONTEXT exactly once', async () => {
    const {count, error} = await run(NO_RETRY_CONTEXT);

    expect(count).toBe(1);
    expect(error).toBeInstanceOf(TypeError);
  });

  it('still retries every other operation up to five attempts', async () => {
    const {count} = await run();

    expect(count).toBe(5);
  });
});

describe('the app client honours NO_RETRY_CONTEXT (ENG-703)', () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
  });

  it('sends a no-retry mutation to the API once when the network is down', async () => {
    const fetchMock = jest.fn(() =>
      Promise.reject(new TypeError('Network request failed')),
    );
    global.fetch = fetchMock as unknown as typeof fetch;
    const client = require('../../src/graphql/ApolloClient').default;

    await expect(
      client.mutate({mutation: MUTATION, context: NO_RETRY_CONTEXT}),
    ).rejects.toMatchObject({
      networkError: expect.any(TypeError),
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
