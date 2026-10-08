import { PrismaClient } from "@prisma/client";

const globalForPrisma = globalThis as unknown as { prisma: PrismaClient };

export const prisma =
  globalForPrisma.prisma ??
  // Raw Prisma errors may contain query arguments, including OAuth subject.
  new PrismaClient({ log: [] });

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;
