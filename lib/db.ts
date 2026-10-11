import "server-only";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";
import { getConfig } from "@/lib/config";

export type Db = PrismaClient;

export function createDb(connectionString: string): Db {
  return new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
}

const globalForDb = globalThis as unknown as { posDb?: Db };

/** Shared Prisma client. Reused across hot reloads in development. */
export function getDb(): Db {
  if (!globalForDb.posDb) {
    globalForDb.posDb = createDb(getConfig().DATABASE_URL);
  }
  return globalForDb.posDb;
}
