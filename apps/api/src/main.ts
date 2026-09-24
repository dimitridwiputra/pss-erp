import 'reflect-metadata';
import { Controller, Get, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { HealthResponseSchema, type HealthResponse } from '@pss/contracts';

@Controller('health')
class HealthController {
  @Get('live')
  live(): HealthResponse { return HealthResponseSchema.parse({ status: 'ok', service: 'api' }); }

  @Get('ready')
  ready(): HealthResponse { return HealthResponseSchema.parse({ status: 'ok', service: 'api' }); }
}

@Module({ controllers: [HealthController] })
class AppModule {}

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  await app.listen(Number(process.env.PORT ?? 4000), '0.0.0.0');
}

void bootstrap();
