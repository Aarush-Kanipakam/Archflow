import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { Pool } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';

@Injectable()
export class PrismaService implements OnModuleInit, OnModuleDestroy {
  public client: PrismaClient;

  constructor() {
    const connectionString = process.env.DATABASE_URL;
    const pool = new Pool({ connectionString });
    const adapter = new PrismaPg(pool);
    this.client = new PrismaClient({ adapter });
  }

  // Expose models directly so existing code like `this.prisma.user` continues to work
  get user() { return this.client.user; }
  get session() { return this.client.session; }
  get board() { return this.client.board; }
  get shape() { return this.client.shape; }
  get boardMember() { return this.client.boardMember; }

  async onModuleInit() {
    // Connect to the database when the module is initialized
    await this.client.$connect();
  }

  async onModuleDestroy() {
    // Disconnect when the module is destroyed (shutting down)
    await this.client.$disconnect();
  }
}
