/**
 * Seed + exercise VictimsService.upsertFromVital (create/rebind/stale).
 * Prefer compiled runner: node scripts/qa-runner.js (after npm run build).
 * This TS file documents the same flow for ts-node when available.
 */
import { NestFactory } from '@nestjs/core';
import { PrismaClient, Priority } from '@prisma/client';
import { AppModule } from '../src/app.module';
import { VictimsService } from '../src/victims/victims.service';

async function ensureInfra(prisma: PrismaClient) {
  const stationId = 'ST-QA-V7';
  const nodeIdA = 'ND-QA-V7-A';
  const nodeIdB = 'ND-QA-V7-B';

  await prisma.station.upsert({
    where: { id: stationId },
    create: { id: stationId, name: 'QA Station Victims' },
    update: { isActive: true },
  });

  for (const id of [nodeIdA, nodeIdB]) {
    await prisma.node.upsert({
      where: { id },
      create: { id, stationId, name: id },
      update: { isActive: true, stationId },
    });
  }

  return { nodeIdA, nodeIdB };
}

async function main() {
  const prisma = new PrismaClient();
  const { nodeIdA, nodeIdB } = await ensureInfra(prisma);
  await prisma.$disconnect();

  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: false,
  });
  const victims = app.get(VictimsService);

  const rfid = 'RFID-3021-QA';
  const now = Date.now();

  const empty = await victims.upsertFromVital(nodeIdA, null, {
    priority: Priority.GREEN,
    confidence: 0.5,
    reasons: [],
  });

  const created = await victims.upsertFromVital(
    nodeIdA,
    rfid,
    {
      priority: Priority.YELLOW,
      confidence: 0.82,
      reasons: ['hr_elevated', 'spo2_ok'],
    },
    new Date(now),
  );

  const rebound = await victims.upsertFromVital(
    nodeIdB,
    rfid,
    {
      priority: Priority.RED,
      confidence: 0.91,
      reasons: ['hr_critical'],
    },
    new Date(now + 1000),
  );

  const stale = await victims.upsertFromVital(
    nodeIdA,
    rfid,
    {
      priority: Priority.GREEN,
      confidence: 0.1,
      reasons: ['stale'],
    },
    new Date(now - 5000),
  );

  console.log(
    JSON.stringify(
      {
        emptyIsNull: empty === null,
        created,
        rebound: {
          created: rebound?.created,
          priorityChanged: rebound?.priorityChanged,
          fromPriority: rebound?.fromPriority,
          toPriority: rebound?.toPriority,
          nodeId: rebound?.victim.currentNodeId,
        },
        staleNodeId: stale?.victim.currentNodeId,
        rfid,
        victimId: created?.victim.id,
      },
      null,
      2,
    ),
  );

  await app.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
