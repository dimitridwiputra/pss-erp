import 'reflect-metadata';
import { Controller, Get, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { createHttpRequestLogging, ProblemExceptionFilter } from '@pss/http';

@Controller('health')
class HealthController {
  @Get('live')
  live() { return { status: 'ok', service: 'integration-worker' }; }

  @Get('ready')
  ready() { return { status: 'ok', service: 'integration-worker' }; }
}

@Module({ controllers: [HealthController] })
class AppModule {}

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.use(createHttpRequestLogging('integration-worker'));
  app.useGlobalFilters(new ProblemExceptionFilter());
  await app.listen(Number(process.env.PORT ?? 4002), '0.0.0.0');
}

void bootstrap();
