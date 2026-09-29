import { AsyncLocalStorage } from 'node:async_hooks';
import type { TraceContext } from './trace-context';

/**
 * Process-local trace context store (OBS-001.R02).
 *
 * A request, a job, and an event consumer each enter their own scope, so any logger
 * created inside the scope can read the active trace id without threading arguments
 * through every domain signature. Nothing here is a span: only the W3C ids live here.
 */
const traceContextStorage = new AsyncLocalStorage<TraceContext>();

export function runWithTraceContext<T>(context: TraceContext, run: () => T): T {
  return traceContextStorage.run(context, run);
}

export function currentTraceContext(): TraceContext | undefined {
  return traceContextStorage.getStore();
}

/** Log fields for the active trace, or an empty object outside a traced scope. */
export function currentTraceFields(): { traceId: string; spanId: string } | Record<string, never> {
  const context = currentTraceContext();
  return context ? { traceId: context.traceId, spanId: context.spanId } : {};
}
