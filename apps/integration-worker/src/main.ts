import 'reflect-metadata';
import { Controller, Get, Inject, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { createHttpRequestLogging, ProblemExceptionFilter } from '@pss/http';
import { EventPipelineService } from './event-pipeline';

@Controller('health')
class HealthController {
  constructor(@Inject(EventPipelineService) private readonly pipeline: EventPipelineService) {}
  @Get('live')
  live() { return { status: 'ok', service: 'integration-worker' }; }

  @Get('ready')
  async ready() { await this.pipeline.assertReady(); return { status: 'ok', service: 'integration-worker' }; }
}

@Module({ controllers: [HealthController], providers: [EventPipelineService] })
class AppModule {}

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.use(createHttpRequestLogging('integration-worker'));
  app.useGlobalFilters(new ProblemExceptionFilter());
  await app.listen(Number(process.env.PORT ?? 4002), '0.0.0.0');
}

void bootstrap();
