import 'reflect-metadata';
import { Module, RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { NestFactory, type INestApplication } from '@nestjs/core';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { ProblemDetailsSchema } from '@pss/contracts';
import { ProblemExceptionFilter } from '@pss/http';
import { isDemoPosEnabled } from '../src/demo-pos-guard';
import { IdentityService } from '../src/identity.controller';
import { PosController, PosService } from '../src/pos.controller';

@Module({ controllers: [PosController], providers: [PosService, IdentityService] })
class PosProbeModule {}

// Every route PosController declares, read from its Nest metadata, so a new route is covered too.
const routes: [string, string][] = Object.getOwnPropertyNames(PosController.prototype).flatMap((name) => {
  const handler = (PosController.prototype as unknown as Record<string, unknown>)[name];
  const path = typeof handler === 'function' ? Reflect.getMetadata(PATH_METADATA, handler) as string | undefined : undefined;
  if (name === 'constructor' || path === undefined) return [];
  const method = RequestMethod[Reflect.getMetadata(METHOD_METADATA, handler) as RequestMethod];
  return [[method, `/${path.replace(/:[a-zA-Z]+/g, 'x')}`] as [string, string]];
});

describe('MVP-OD-5 demo POS switch', () => {
  let app: INestApplication;
  let baseUrl: string;

  beforeAll(async () => {
    app = await NestFactory.create(PosProbeModule, { logger: false });
    app.useGlobalFilters(new ProblemExceptionFilter());
    await app.listen(0, '127.0.0.1');
    baseUrl = await app.getUrl();
  });

  afterAll(async () => { await app?.close(); });
  afterEach(() => { vi.unstubAllEnvs(); });

  const call = (method: string, path: string) => fetch(`${baseUrl}${path}`, {
    method, headers: { 'content-type': 'application/json', authorization: 'Bearer not-a-real-token' },
    ...(method === 'POST' ? { body: '{"organizationId":"attacker"}' } : {}),
  });

  it('finds the POS and Kasir routes', () => {
    expect(routes.length).toBeGreaterThanOrEqual(12);
    expect(routes.every(([, path]) => path.startsWith('/pos/') || path.startsWith('/kasir/'))).toBe(true);
  });

  it.each(routes)('%s %s answers FEATURE_DISABLED when the flag is unset, before auth or validation', async (method, path) => {
    vi.stubEnv('PSS_DEMO_POS_ENABLED', undefined);
    const response = await call(method, path);
    expect(response.status).toBe(403);
    expect(response.headers.get('content-type')).toContain('application/problem+json');
    const problem = ProblemDetailsSchema.parse(await response.json());
    expect(problem).toMatchObject({ code: 'FEATURE_DISABLED', retryable: false });
  });

  it('stays off in production even when the flag is on', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('PSS_DEMO_POS_ENABLED', 'true');
    const response = await call('GET', '/kasir/shift-saya');
    expect(response.status).toBe(403);
    expect((await response.json()).code).toBe('FEATURE_DISABLED');
  });

  it('lets a request through to authentication when enabled outside production', async () => {
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('PSS_DEMO_POS_ENABLED', 'true');
    const response = await call('GET', '/kasir/shift-saya');
    expect((await response.json()).code).not.toBe('FEATURE_DISABLED');
  });

  it.each([undefined, '', '1', 'TRUE', 'yes', ' true'])('treats %j as off', (value) => {
    expect(isDemoPosEnabled({ NODE_ENV: 'development', PSS_DEMO_POS_ENABLED: value })).toBe(false);
  });
});
