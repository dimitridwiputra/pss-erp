import 'reflect-metadata';
import { Controller, Get, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { HealthResponseSchema, type HealthResponse } from '@pss/contracts';
import { createHttpRequestLogging, ProblemExceptionFilter } from '@pss/http';
import { IdentityAdminController, IdentityController, IdentityService } from './identity.controller';
import { ApprovalController, ApprovalService } from './approval.controller';
import { WmsController, WmsService } from './wms.controller';
import { PosController, PosService } from './pos.controller';
import { BackofficeProductController, BackofficeProductService } from './backoffice-product.controller';
import { BackofficePriceListController, BackofficePriceListService } from './backoffice-price-list.controller';
import { BackofficeStockController, BackofficeStockService } from './backoffice-stock.controller';
import { CounterBackofficeController, CounterBackofficeService } from './counter-backoffice.controller';

@Controller('health')
class HealthController {
  @Get('live')
  live(): HealthResponse { return HealthResponseSchema.parse({ status: 'ok', service: 'api' }); }

  @Get('ready')
  ready(): HealthResponse { return HealthResponseSchema.parse({ status: 'ok', service: 'api' }); }
}

@Module({
  controllers: [HealthController, IdentityController, IdentityAdminController, ApprovalController, WmsController, PosController, CounterBackofficeController, BackofficeProductController, BackofficePriceListController, BackofficeStockController],
  providers: [IdentityService, ApprovalService, WmsService, PosService, CounterBackofficeService, BackofficeProductService, BackofficePriceListService, BackofficeStockService],
})
class AppModule {}

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.use(createHttpRequestLogging('api'));
  app.useGlobalFilters(new ProblemExceptionFilter());
  await app.listen(Number(process.env.PORT ?? 4000), '0.0.0.0');
}

void bootstrap();
