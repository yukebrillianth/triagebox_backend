/**
 * Packet loss and link quality for one node over a time window.
 *
 *   npm run report:link -- --node node-01 --from 2026-10-25T09:00:00+07:00 \
 *       --to 2026-10-25T09:30:00+07:00 [--period 15] [--csv]
 *
 * Received = answered polls (LinkSample rows, one per status message the station
 * publishes for an answering node). Expected = polls the schedule called in the
 * window, from the cycle period. Use one window per distance (e.g. 100/250/400/
 * 500 m) with at least 100 polls each.
 */
import { PrismaClient } from '@prisma/client';
import { linkWindow } from '../src/common/link-stats';
import { pollPeriodSec } from '../src/common/timing';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const nodeId = arg('node');
  const from = arg('from');
  const to = arg('to');
  if (!nodeId || !from || !to) {
    console.error('usage: report:link -- --node <id> --from <ISO> --to <ISO> [--period <s>] [--csv]');
    process.exit(2);
  }
  const fromD = new Date(from);
  const toD = new Date(to);
  if (Number.isNaN(fromD.getTime()) || Number.isNaN(toD.getTime()) || toD <= fromD) {
    console.error('--from/--to must be ISO timestamps with --to after --from');
    process.exit(2);
  }
  const period = Number(arg('period') ?? pollPeriodSec());
  const prisma = new PrismaClient();
  try {
    const rows = await prisma.linkSample.findMany({
      where: { nodeId, receivedAt: { gte: fromD, lte: toD } },
      orderBy: { receivedAt: 'asc' },
      select: { rssi: true, snr: true },
    });
    // Window = the requested one, not first-to-last answer: a dead link at the
    // far end of a range test is exactly the loss being measured.
    const w = linkWindow(fromD.getTime(), toD.getTime(), period, rows.length);
    const rssi = rows.map((r) => r.rssi).filter((v): v is number => v != null);
    const snr = rows.map((r) => r.snr).filter((v): v is number => v != null);
    const avg = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
    const fmt = (n: number, d = 1) => (Number.isFinite(n) ? n.toFixed(d) : '');
    const out = {
      node: nodeId,
      period_s: period,
      expected: w.expected,
      received: w.received,
      loss_pct: w.lossPct ?? '',
      rssi_avg: fmt(avg(rssi)),
      rssi_min: rssi.length ? Math.min(...rssi) : '',
      snr_avg: fmt(avg(snr)),
      snr_min: snr.length ? Math.min(...snr) : '',
    };
    if (process.argv.includes('--csv')) {
      console.log(Object.keys(out).join(','));
      console.log(Object.values(out).join(','));
    } else {
      for (const [k, v] of Object.entries(out)) console.log(`${k.padEnd(10)} ${v}`);
      if (w.expected < 100) {
        console.log(`note: only ${w.expected} polls expected; use >= 100 per distance for the article`);
      }
    }
  } finally {
    await prisma.$disconnect();
  }
}

void main();
