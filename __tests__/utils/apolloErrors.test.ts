import {ApolloError} from '@apollo/client';

import {isApiUnreachable} from '../../src/utils/apolloErrors';

describe('isApiUnreachable (ENG-703)', () => {
  it('is true when the request never reached a server (fetch threw)', () => {
    expect(
      isApiUnreachable({
        networkError: new TypeError('Network request failed'),
        graphQLErrors: [],
      }),
    ).toBe(true);
  });

  it('is true for the ApolloError a failed fetch actually rejects with', () => {
    expect(
      isApiUnreachable(
        new ApolloError({
          networkError: new TypeError('Network request failed'),
        }),
      ),
    ).toBe(true);
  });

  it('is true for a server failure (5xx)', () => {
    expect(isApiUnreachable({networkError: {statusCode: 503}})).toBe(true);
    expect(isApiUnreachable({networkError: {statusCode: 500}})).toBe(true);
  });

  it('is false for a 4xx: the server answered (an expired session is not "offline")', () => {
    expect(isApiUnreachable({networkError: {statusCode: 401}})).toBe(false);
    expect(isApiUnreachable({networkError: {statusCode: 400}})).toBe(false);
  });

  it('is false for a GraphQL error', () => {
    expect(isApiUnreachable({networkError: null, graphQLErrors: [{}]})).toBe(
      false,
    );
    expect(
      isApiUnreachable({
        networkError: new TypeError('Network request failed'),
        graphQLErrors: [{message: 'bad'}],
      }),
    ).toBe(false);
  });

  it('is false for a plain Error and for no error at all', () => {
    expect(isApiUnreachable(new Error('Network request failed'))).toBe(false);
    expect(isApiUnreachable(undefined)).toBe(false);
    expect(isApiUnreachable(null)).toBe(false);
  });
});
