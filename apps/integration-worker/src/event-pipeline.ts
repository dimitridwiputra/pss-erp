import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Queue, Worker, type ConnectionOptions, type Job } from 'bullmq';
import { Pool } from 'pg';
import {
  dispatchPendingEvents, outboxDeliveryStats, recordConsumerDeadLetter,
  EVENT_RETRY_BACKOFF_MS, type PublishableEvent,
} from '@pss/platform';
import { projectApproval, projectDeliveredOrder } from '@pss/reporting';

const QUEUE_NAME = 'pss-canonical-events';
const CONSUMER_DELIVERY = 'reporting.delivery-status';
const CONSUMER_APPROVAL = 'reporting.approval-status';

/** Event types with a registered consumer. A type absent here is never sent to the broker. */
const REGISTERED_CONSUMERS: Record<string, string> = {
  DELIVERY_ORDER_DELIVERED: CONSUMER_DELIVERY,
  APPROVAL_REQUESTED: CONSUMER_APPROVAL,
  APPROVAL_DECIDED: CONSUMER_APPROVAL,
};

export function redisConnectionFromUrl(rawUrl: string): ConnectionOptions {
  const url = new URL(rawUrl);
  if (!['redis:', 'rediss:'].includes(url.protocol)) throw new Error('REDIS_URL must use redis or rediss.');
  return {
    host: url.hostname,
    port: Number(url.port || 6379),
    ...(url.password ? { password: decodeURIComponent(url.password) } : {}),
    ...(url.protocol === 'rediss:' ? { tls: {} } : {}),
  };
}

export interface EventPipeline {
  tick(): Promise<{ published: number; oldestPendingCreatedAt: string | null }>;
  ready(): Promise<void>;
  close(): Promise<void>;
  /** Depth, age, and dead-letter counts for the PLT-004.R05 / PLT-005.R02 dashboard. */
  stats(): Promise<{ pending: number; deadLettered: number; oldestPendingCreatedAt: string | null }>;
}

/** Redis carries deliveries; PostgreSQL outbox and consumer inbox remain durable truth. */
export function startEventPipeline(pool: Pool, connection: ConnectionOptions, queueName = QUEUE_NAME): EventPipeline {
  const queue = new Queue<PublishableEvent>(queueName, { connection });
  const worker = new Worker<PublishableEvent>(queueName, async (job) => {
    switch (job.name) {
      case 'DELIVERY_ORDER_DELIVERED':
        return projectDeliveredOrder(pool, job.data);
      case 'APPROVAL_REQUESTED':
      case 'APPROVAL_DECIDED':
        return projectApproval(pool, job.data);
      default:
        throw new Error(`No consumer registered for ${job.name}.`);
    }
  }, { connection, concurrency: 1 });
  worker.on('failed', (job: Job<PublishableEvent> | undefined, error: Error) => {
    if (!job) return;
    void recordTerminalFailure(pool, job, error).catch((failure: unknown) => {
      process.stderr.write(`Dead-letter write failed for event ${job.data.eventId}: ${describe(failure)}\n`);
    });
  });

  let dispatching = false;
  async function tick() {
    if (dispatching) {
      return { published: 0, oldestPendingCreatedAt: (await outboxDeliveryStats(pool)).oldestPendingCreatedAt };
    }
    dispatching = true;
    try {
      const result = await dispatchPendingEvents(pool, {
        publish: async (event) => {
          if (!REGISTERED_CONSUMERS[event.eventType]) {
            throw new Error(`No consumer registered for ${event.eventType}.`);
          }
          const job = await queue.add(event.eventType, event, {
            jobId: event.eventId, removeOnComplete: false, removeOnFail: false,
            // PLT-005: the bounded `events.retry_backoff` table is the job's own attempt budget.
            attempts: EVENT_RETRY_BACKOFF_MS.length,
            backoff: { type: 'fixed', delay: EVENT_RETRY_BACKOFF_MS[0]! },
          });
          if (await job.getState() === 'failed') throw new Error(`Event ${event.eventId} is in the failed queue.`);
        },
      }, { limit: 100, onFailure: (attempt) => {
        process.stderr.write(`Outbox dispatch attempt ${attempt.attempt} failed for ${attempt.eventId}: ${attempt.failureCode}${attempt.willRetry ? '' : ' (dead-lettered)'}\n`);
      } });
      return { published: result.published, oldestPendingCreatedAt: result.oldestPendingCreatedAt };
    } finally {
      dispatching = false;
    }
  }

  return {
    tick,
    ready: async () => { await queue.waitUntilReady(); await worker.waitUntilReady(); await pool.query('SELECT 1'); },
    close: async () => { await worker.close(); await queue.close(); },
    stats: () => outboxDeliveryStats(pool),
  };
}

/**
 * PLT-005.AC03: once BullMQ has spent its own attempt budget the failure becomes a durable,
 * visible dead letter in PostgreSQL. Redis can be wiped; a failed-job set cannot be the only
 * record that an event was lost.
 */
async function recordTerminalFailure(pool: Pool, job: Job<PublishableEvent>, error: Error): Promise<void> {
  const consumerName = REGISTERED_CONSUMERS[job.name];
  if (!consumerName || job.attemptsMade < EVENT_RETRY_BACKOFF_MS.length) return;
  await recordConsumerDeadLetter(pool, {
    consumerName, event: job.data, attemptCount: job.attemptsMade, cause: 'HANDLER_FAILED', error,
  });
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : 'unknown error';
}

@Injectable()
export class EventPipelineService implements OnModuleInit, OnModuleDestroy {
  private pool: Pool | undefined;
  private pipeline: EventPipeline | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;

  async onModuleInit(): Promise<void> {
    if (!process.env.DATABASE_URL || !process.env.REDIS_URL) return;
    this.pool = new Pool({ connectionString: process.env.DATABASE_URL });
    this.pipeline = startEventPipeline(this.pool, redisConnectionFromUrl(process.env.REDIS_URL));
    await this.pipeline.ready();
    this.timer = setInterval(() => {
      void this.pipeline?.tick().catch((error: unknown) => {
        process.stderr.write(`Outbox dispatch failed: ${describe(error)}\n`);
      });
    }, 1000);
    await this.pipeline.tick();
  }

  async assertReady(): Promise<void> {
    if (!this.pipeline) throw new Error('Event pipeline is not configured.');
    await this.pipeline.ready();
  }

  async onModuleDestroy(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    await this.pipeline?.close();
    await this.pool?.end();
  }
}
