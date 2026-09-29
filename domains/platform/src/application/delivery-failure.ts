import { DomainError, findErrorCode } from '@pss/contracts';
import { z } from 'zod';

/**
 * PLT-005 requires classifying a delivery failure as transient (retry) or permanent (dead
 * letter). A retryable HTTP category is the registered signal: 429 and 503 are the only
 * Appendix F categories a later attempt can change. A validation failure is the opposite: the
 * same bytes will fail the same way forever, so retrying only delays the dead letter.
 */
export type DeliveryFailureClass = 'TRANSIENT' | 'PERMANENT';

export interface ClassifiedDeliveryFailure {
  class: DeliveryFailureClass;
  code: string;
  message: string;
}

const RETRYABLE_HTTP_CATEGORIES = ['429', '503'];
const MAX_MESSAGE_LENGTH = 500;

/** A stable, bounded code for operators and dashboards; never an unbounded stack trace. */
export function classifyDeliveryFailure(error: unknown): ClassifiedDeliveryFailure {
  if (error instanceof DomainError) {
    const category = findErrorCode(error.code)?.httpCategory ?? '';
    return {
      class: RETRYABLE_HTTP_CATEGORIES.some((prefix) => category.startsWith(prefix)) ? 'TRANSIENT' : 'PERMANENT',
      code: error.code,
      message: error.message,
    };
  }
  if (error instanceof z.ZodError) {
    return { class: 'PERMANENT', code: 'EVENT_SCHEMA_INVALID', message: 'Event payload failed schema validation.' };
  }
  return {
    class: 'TRANSIENT',
    code: 'UNEXPECTED_CONSUMER_FAILURE',
    message: error instanceof Error ? error.message : 'Unknown consumer failure.',
  };
}

/** Dead-letter rows are operator-facing; a message longer than this is truncated, never dropped silently. */
export function boundedFailureMessage(message: string): string {
  return message.length <= MAX_MESSAGE_LENGTH ? message : `${message.slice(0, MAX_MESSAGE_LENGTH - 1)}…`;
}
