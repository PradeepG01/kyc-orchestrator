import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Pool } from 'pg';

export const SCHEMA_SQL = readFileSync(join(__dirname, 'schema.sql'), 'utf8');

async function migrate() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  await pool.query(SCHEMA_SQL);
  await pool.end();
  console.log('migrations applied');
}

if (require.main === module) {
  migrate().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
