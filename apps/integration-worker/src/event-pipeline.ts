import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Queue, Worker, type ConnectionOptions } from 'bullmq';
import { Pool } from 'pg';
import { dispatchPendingEvents, type PublishableEvent } from '@pss/platform';
import { projectApproval, projectDeliveredOrder } from '@pss/reporting';

const QUEUE_NAME = 'pss-canonical-events';

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

/** Redis carries deliveries; PostgreSQL outbox and consumer inbox remain durable truth. */
export function startEventPipeline(pool: Pool, connection: ConnectionOptions, queueName = QUEUE_NAME) {
  const queue = new Queue<PublishableEvent>(queueName, { connection });
  const worker = new Worker<PublishableEvent>(queueName, async (job) => {
    switch (job.name) {
      case 'DELIVERY_ORDER_DELIVERED':
        await projectDeliveredOrder(pool, job.data);
        return;
      case 'APPROVAL_REQUESTED':
      case 'APPROVAL_DECIDED':
        await projectApproval(pool, job.data);
        return;
      default:
        throw new Error(`No consumer registered for ${job.name}.`);
    }
  }, { connection, concurrency: 1 });
  worker.on('failed', (job, error) => {
    process.stderr.write(`Event job ${job?.id ?? 'unknown'} failed: ${error.message}\n`);
  });

  let dispatching = false;
  async function tick(): Promise<number> {
    if (dispatching) return 0;
    dispatching = true;
    try {
      return await dispatchPendingEvents(pool, {
        publish: async (event) => {
          if (!['DELIVERY_ORDER_DELIVERED', 'APPROVAL_REQUESTED', 'APPROVAL_DECIDED'].includes(event.eventType)) {
            throw new Error(`No consumer registered for ${event.eventType}.`);
          }
          const job = await queue.add(event.eventType, event, {
            jobId: event.eventId,
            attempts: 5,
            backoff: { type: 'exponential', delay: 1000 },
            removeOnComplete: false,
            removeOnFail: false,
          });
          if (await job.getState() === 'failed') throw new Error(`Event ${event.eventId} is in the failed queue.`);
        },
      }, 100);
    } finally {
      dispatching = false;
    }
  }

  return {
    tick,
    ready: async () => { await queue.waitUntilReady(); await worker.waitUntilReady(); await pool.query('SELECT 1'); },
    close: async () => { await worker.close(); await queue.close(); },
  };
}

@Injectable()
export class EventPipelineService implements OnModuleInit, OnModuleDestroy {
  private pool: Pool | undefined;
  private pipeline: ReturnType<typeof startEventPipeline> | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;

  async onModuleInit(): Promise<void> {
    if (!process.env.DATABASE_URL || !process.env.REDIS_URL) return;
    this.pool = new Pool({ connectionString: process.env.DATABASE_URL });
    this.pipeline = startEventPipeline(this.pool, redisConnectionFromUrl(process.env.REDIS_URL));
    await this.pipeline.ready();
    this.timer = setInterval(() => {
      void this.pipeline?.tick().catch((error: unknown) => {
        process.stderr.write(`Outbox dispatch failed: ${error instanceof Error ? error.message : 'unknown error'}\n`);
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
