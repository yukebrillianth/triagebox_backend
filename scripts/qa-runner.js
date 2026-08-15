const { NestFactory } = require('@nestjs/core');
const { PrismaClient, Priority } = require('@prisma/client');
const { AppModule } = require('../dist/app.module');
const { VictimsService } = require('../dist/victims/victims.service');

async function ensureInfra(prisma) {
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

  const counts = await victims.countByPriority();

  console.log(
    JSON.stringify(
      {
        emptyIsNull: empty === null,
        created: {
          created: created?.created,
          victimId: created?.victim.id,
          nodeId: created?.victim.currentNodeId,
          priority: created?.victim.currentPriority,
        },
        rebound: {
          created: rebound?.created,
          priorityChanged: rebound?.priorityChanged,
          fromPriority: rebound?.fromPriority,
          toPriority: rebound?.toPriority,
          nodeId: rebound?.victim.currentNodeId,
          priority: rebound?.victim.currentPriority,
        },
        staleIgnored: {
          nodeId: stale?.victim.currentNodeId,
          priority: stale?.victim.currentPriority,
        },
        rfid,
        victimId: created?.victim.id,
        counts,
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
