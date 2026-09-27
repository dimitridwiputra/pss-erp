import 'reflect-metadata';
import { Controller, Get, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { HealthResponseSchema, type HealthResponse } from '@pss/contracts';
import { createHttpRequestLogging, ProblemExceptionFilter } from '@pss/http';
import { IdentityController, IdentityService } from './identity.controller';

@Controller('health')
class HealthController {
  @Get('live')
  live(): HealthResponse { return HealthResponseSchema.parse({ status: 'ok', service: 'api' }); }

  @Get('ready')
  ready(): HealthResponse { return HealthResponseSchema.parse({ status: 'ok', service: 'api' }); }
}

@Module({ controllers: [HealthController, IdentityController], providers: [IdentityService] })
class AppModule {}

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.use(createHttpRequestLogging('api'));
  app.useGlobalFilters(new ProblemExceptionFilter());
  await app.listen(Number(process.env.PORT ?? 4000), '0.0.0.0');
}

void bootstrap();
