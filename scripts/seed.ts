/**
 * Idempotent demo seed: 2 stations, 10 nodes, default settings.
 * Run: npm run seed
 */
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const STATIONS = [
  {
    id: "st-01",
    name: "Station Alpha",
    ipAddress: "192.168.10.11",
    mqttBrokerHost: "192.168.10.1",
    mqttBrokerPort: 1883,
    firmware: "1.0.0",
    notes: "Seed station 1",
  },
  {
    id: "st-02",
    name: "Station Bravo",
    ipAddress: "192.168.10.12",
    mqttBrokerHost: "192.168.10.1",
    mqttBrokerPort: 1883,
    firmware: "1.0.0",
    notes: "Seed station 2",
  },
] as const;

/** node-01..05 → st-01, node-06..10 → st-02 */
function nodesForSeed() {
  const nodes: { id: string; stationId: string; name: string }[] = [];
  for (let i = 1; i <= 10; i++) {
    const id = `node-${String(i).padStart(2, "0")}`;
    const stationId = i <= 5 ? "st-01" : "st-02";
    nodes.push({ id, stationId, name: `Node ${String(i).padStart(2, "0")}` });
  }
  return nodes;
}

const SETTINGS: { key: string; value: string }[] = [
  { key: "hospital_name", value: "RS Lapangan Demo" },
  { key: "disaster_name", value: "Gempa Demo PKM" },
  { key: "operator", value: "Operator Demo" },
];

async function main() {
  for (const s of STATIONS) {
    await prisma.station.upsert({
      where: { id: s.id },
      create: {
        id: s.id,
        name: s.name,
        ipAddress: s.ipAddress,
        mqttBrokerHost: s.mqttBrokerHost,
        mqttBrokerPort: s.mqttBrokerPort,
        firmware: s.firmware,
        notes: s.notes,
        isActive: true,
      },
      update: {
        name: s.name,
        ipAddress: s.ipAddress,
        mqttBrokerHost: s.mqttBrokerHost,
        mqttBrokerPort: s.mqttBrokerPort,
        firmware: s.firmware,
        notes: s.notes,
        isActive: true,
      },
    });
  }

  for (const n of nodesForSeed()) {
    await prisma.node.upsert({
      where: { id: n.id },
      create: {
        id: n.id,
        stationId: n.stationId,
        name: n.name,
        isActive: true,
      },
      update: {
        stationId: n.stationId,
        name: n.name,
        isActive: true,
      },
    });
  }

  // Defaults only if missing - do not clobber operator edits on re-seed
  for (const row of SETTINGS) {
    await prisma.setting.upsert({
      where: { key: row.key },
      create: { key: row.key, value: row.value },
      update: {},
    });
  }

  const [stations, nodes, settings] = await Promise.all([
    prisma.station.count({
      where: { id: { in: ["st-01", "st-02"] }, isActive: true },
    }),
    prisma.node.count({
      where: {
        id: {
          in: Array.from(
            { length: 10 },
            (_, i) => `node-${String(i + 1).padStart(2, "0")}`,
          ),
        },
        isActive: true,
      },
    }),
    prisma.setting.findMany({
      where: {
        key: { in: ["hospital_name", "disaster_name", "operator"] },
      },
    }),
  ]);

  console.log(
    JSON.stringify(
      {
        ok: true,
        stations,
        nodes,
        settings: Object.fromEntries(settings.map((s) => [s.key, s.value])),
      },
      null,
      2,
    ),
  );
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
