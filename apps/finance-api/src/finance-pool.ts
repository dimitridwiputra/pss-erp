import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { Pool } from 'pg';

@Injectable()
export class FinancePool extends Pool implements OnModuleDestroy {
  constructor() {
    super({ connectionString: process.env.DATABASE_URL });
  }

  async onModuleDestroy() { await this.end(); }
}
