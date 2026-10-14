import React from 'react';
import {ApolloProvider} from '@apollo/client';
import {act, renderHook, waitFor} from '@testing-library/react-native';

// The price subscription needs a websocket the backend does not expose; this
// spec is about the HTTP price query, so the subscription stays quiet.
jest.mock('@apollo/client', () => ({
  ...jest.requireActual('@apollo/client'),
  useSubscription: () => ({data: undefined}),
}));

describe('useSatPrice offline (ENG-703)', () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
  });

  it('sends the price query and refetchPrice once each when fetch rejects', async () => {
    const fetchMock = jest.fn(() =>
      Promise.reject(new TypeError('Network request failed')),
    );
    global.fetch = fetchMock as unknown as typeof fetch;
    // The app client, so its shared RetryLink is the one under test.
    const client = require('../../src/graphql/ApolloClient').default;
    const useSatPrice = require('../../src/hooks/useSatPrice').default;

    const wrapper = ({children}: {children: React.ReactNode}) => (
      <ApolloProvider client={client}>{children}</ApolloProvider>
    );
    const hook = renderHook(() => useSatPrice(), {wrapper});

    // The mount-time query goes out once, not five times.
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    // The keypad's cold-start fetch resolves to "no price" after a single
    // request, so the card is offered without a retry cycle.
    let usdPerSat: number | undefined;
    await act(async () => {
      usdPerSat = await hook.result.current.refetchPrice();
    });

    expect(usdPerSat).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    hook.unmount();
  });
});
