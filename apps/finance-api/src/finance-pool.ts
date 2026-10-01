import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { Pool } from 'pg';

@Injectable()
export class FinancePool extends Pool implements OnModuleDestroy {
  constructor() {
    super({ connectionString: process.env.DATABASE_URL });
    this.on('error', (error: Error) => {
      process.stderr.write(`Finance idle database connection closed: ${error.message}\n`);
    });
  }

  async onModuleDestroy() { await this.end(); }
}
