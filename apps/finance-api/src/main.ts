import 'reflect-metadata';
import { Controller, Get, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { createHttpRequestLogging, ProblemExceptionFilter } from '@pss/http';
import { Pool } from 'pg';
import { FinanceAuth } from './finance-auth';
import { FinanceController } from './finance.controller';
import { FinancePeriodController } from './finance-period.controller';
import { FinanceManualController } from './finance-manual.controller';
import { FinanceExceptionController } from './finance-exception.controller';

@Controller('health')
class HealthController {
  @Get('live')
  live() { return { status: 'ok', service: 'finance-api' }; }

  @Get('ready')
  ready() { return { status: 'ok', service: 'finance-api' }; }
}

@Module({
  controllers: [HealthController, FinanceController, FinancePeriodController, FinanceManualController, FinanceExceptionController],
  providers: [FinanceAuth, { provide: 'FINANCE_POOL', useFactory: () => new Pool({ connectionString: process.env.DATABASE_URL }) }],
})
class AppModule {}

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.use(createHttpRequestLogging('finance-api'));
  app.useGlobalFilters(new ProblemExceptionFilter());
  await app.listen(Number(process.env.PORT ?? 4001), '0.0.0.0');
}

void bootstrap();
