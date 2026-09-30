'use client';

import { useMutation } from '@tanstack/react-query';
import { useRef } from 'react';
import { KasirApiError, newIdempotencyKey } from '../lib/api-client';

/**
 * A server command with retry-safe idempotency (PLT-006). The Idempotency-Key is created once per
 * distinct request and kept across a network failure, so pressing the button again replays the
 * same request instead of charging twice. A definitive answer from the server — success or a
 * refusal — retires the key, and so does sending different input.
 */
export function useCommand<TInput, TResult>(
  send: (input: TInput, idempotencyKey: string) => Promise<TResult>,
  options: { onSuccess?: (result: TResult, input: TInput) => void | Promise<void> } = {},
) {
  const pending = useRef<{ key: string; fingerprint: string } | null>(null);
  return useMutation<TResult, Error, TInput>({
    mutationFn: (input) => {
      const fingerprint = JSON.stringify(input ?? null);
      if (!pending.current || pending.current.fingerprint !== fingerprint) {
        pending.current = { key: newIdempotencyKey(), fingerprint };
      }
      return send(input, pending.current.key);
    },
    onSuccess: async (result, input) => {
      pending.current = null;
      await options.onSuccess?.(result, input);
    },
    onError: (error) => {
      const retrySafe = error instanceof KasirApiError && (error.problem.retryable || error.problem.code === 'REQUEST_IN_PROGRESS');
      if (error instanceof KasirApiError && !retrySafe) pending.current = null;
    },
  });
}
