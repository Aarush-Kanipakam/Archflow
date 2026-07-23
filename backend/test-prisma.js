const { PrismaClient } = require('@prisma/client');
const { Pool } = require('pg');
const { PrismaPg } = require('@prisma/adapter-pg');

async function test() {
  const pool = new Pool({ connectionString: 'postgresql://archflow:archflow_dev_password@localhost:5432/archflow?schema=public' });
  const adapter = new PrismaPg(pool);
  const client = new PrismaClient({ adapter });
  try {
    const user = await client.user.findFirst();
    console.log('Success:', user);
  } catch (e) {
    console.error('Error:', e);
  } finally {
    await client.$disconnect();
  }
}
test();
