// The invoice API could not be reached: the request never got a server
// answer (fetch threw: airplane mode, DNS, refused, timeout) or the server
// failed (5xx). A 4xx or any GraphQL error is a real answer and keeps the
// existing error toast.
//
// Duck-typed rather than `instanceof ApolloError` so it reads any error shape
// Apollo hands back (and the screen tests mock `@apollo/client` without it).
export const isApiUnreachable = (err: unknown): boolean => {
  const e = err as
    | {
        networkError?: {statusCode?: number} | null;
        graphQLErrors?: unknown[];
      }
    | null
    | undefined;
  if (!e?.networkError || (e.graphQLErrors?.length ?? 0) > 0) {
    return false;
  }
  const status = e.networkError.statusCode;
  return status === undefined || status >= 500;
};
