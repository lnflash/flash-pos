import type {Operation} from '@apollo/client';

/**
 * Operation context for a request the shared RetryLink must send exactly once.
 *
 * Creating a POS invoice uses it (ENG-703): offline, five retries with backoff
 * hold the merchant on a spinner for 5-9 s before the card charge is offered.
 * Falling back to the card needs no API, and the merchant can go back and try
 * the invoice again.
 */
export const NO_RETRY_CONTEXT = {noRetry: true} as const;

/** RetryLink `retryIf`: retry every failure unless the operation opted out. */
export const shouldRetryOperation = (
  _error: unknown,
  operation: Operation,
): boolean => !operation.getContext().noRetry;
