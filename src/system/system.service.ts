import { BadRequestException, Injectable } from '@nestjs/common';
import { DeviceStatus, Priority, Victim } from '@prisma/client';
import { ActivityService } from '../activity/activity.service';
import { MqttService } from '../mqtt/mqtt.service';
import { PrismaService } from '../prisma/prisma.service';
import { VictimsService } from '../victims/victims.service';

export interface KpiResponse {
  total: number;
  byPriority: Record<Priority, number>;
  onlineNodes: number;
  totalNodes: number;
  onlineStations: number;
  totalStations: number;
}

export interface AnalyticsSummary {
  byPriority: Record<Priority, number>;
  hourlyTrend: { hour: string; count: number }[];
  activeNodes: number;
  avgBattery: number | null;
  nodesTelemetry: {
    id: string;
    name: string;
    rssi: number | null;
    snr: number | null;
    battery: number | null;
    status: DeviceStatus;
  }[];
}

export interface HealthResponse {
  status: 'ok' | 'degraded';
  db: 'up' | 'down';
  mqtt: 'up' | 'down';
  uptimeSec: number;
}

export interface ReportsSummary {
  victims: Victim[];
  counts: { total: number; byPriority: Record<Priority, number> };
  triageHistoryCount: number;
  recentActivity: Awaited<ReturnType<ActivityService['list']>>;
}

@Injectable()
export class SystemService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly mqtt: MqttService,
    private readonly victims: VictimsService,
    private readonly activity: ActivityService,
  ) {}

  async getKpis(): Promise<KpiResponse> {
    const [byPriority, onlineNodes, totalNodes, onlineStations, totalStations] =
      await Promise.all([
        this.victims.countByPriority(),
        this.prisma.node.count({
          where: { isActive: true, status: DeviceStatus.ONLINE },
        }),
        this.prisma.node.count({ where: { isActive: true } }),
        this.prisma.station.count({
          where: { isActive: true, status: DeviceStatus.ONLINE },
        }),
        this.prisma.station.count({ where: { isActive: true } }),
      ]);
    const total =
      byPriority.RED + byPriority.YELLOW + byPriority.GREEN + byPriority.BLACK;
    return {
      total,
      byPriority,
      onlineNodes,
      totalNodes,
      onlineStations,
      totalStations,
    };
  }

  async getAnalyticsSummary(): Promise<AnalyticsSummary> {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const [byPriority, activeNodes, batteryAgg, nodesTelemetry, readings] =
      await Promise.all([
        this.victims.countByPriority(),
        this.prisma.node.count({
          where: { isActive: true, status: DeviceStatus.ONLINE },
        }),
        this.prisma.node.aggregate({
          where: { isActive: true, battery: { not: null } },
          _avg: { battery: true },
        }),
        this.prisma.node.findMany({
          where: { isActive: true },
          select: {
            id: true,
            name: true,
            rssi: true,
            snr: true,
            battery: true,
            status: true,
          },
          orderBy: { id: 'asc' },
        }),
        this.prisma.vitalReading.findMany({
          where: { receivedAt: { gte: since } },
          select: { receivedAt: true },
        }),
      ]);

    const nowHour = new Date();
    nowHour.setMinutes(0, 0, 0);
    const buckets = new Map<string, number>();
    for (let i = 23; i >= 0; i--) {
      buckets.set(new Date(nowHour.getTime() - i * 60 * 60 * 1000).toISOString(), 0);
    }
    for (const r of readings) {
      const h = new Date(r.receivedAt);
      h.setMinutes(0, 0, 0);
      const key = h.toISOString();
      buckets.set(key, (buckets.get(key) ?? 0) + 1);
    }
    const hourlyTrend = [...buckets.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([hour, count]) => ({ hour, count }));

    return {
      byPriority,
      hourlyTrend,
      activeNodes,
      avgBattery: batteryAgg._avg.battery,
      nodesTelemetry,
    };
  }

  async getHealth(): Promise<HealthResponse> {
    let db: 'up' | 'down' = 'down';
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      db = 'up';
    } catch {
      db = 'down';
    }
    const mqtt: 'up' | 'down' = this.mqtt.isConnected() ? 'up' : 'down';
    const status: 'ok' | 'degraded' =
      db === 'up' && mqtt === 'up' ? 'ok' : 'degraded';
    return {
      status,
      db,
      mqtt,
      uptimeSec: Math.floor(process.uptime()),
    };
  }

  async getSettings(): Promise<Record<string, string>> {
    const rows = await this.prisma.setting.findMany();
    const out: Record<string, string> = {};
    for (const row of rows) {
      out[row.key] = row.value;
    }
    return out;
  }

  async putSettings(body: Record<string, unknown>): Promise<Record<string, string>> {
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
      throw new BadRequestException('body must be a JSON object of key-value pairs');
    }
    const entries = Object.entries(body);
    if (entries.length === 0) {
      throw new BadRequestException('body must contain at least one key');
    }
    for (const [key, value] of entries) {
      if (typeof key !== 'string' || key.trim() === '') {
        throw new BadRequestException('keys must be non-empty strings');
      }
      if (value === null || value === undefined) {
        throw new BadRequestException(`value for '${key}' must be a string`);
      }
      if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
        throw new BadRequestException(`value for '${key}' must be a string, number, or boolean`);
      }
      const str = String(value);
      await this.prisma.setting.upsert({
        where: { key },
        create: { key, value: str },
        update: { value: str },
      });
    }
    return this.getSettings();
  }

  async getReportsSummary(): Promise<ReportsSummary> {
    const [victims, byPriority, triageHistoryCount, recentActivity] =
      await Promise.all([
        this.prisma.victim.findMany({ orderBy: { lastUpdate: 'desc' } }),
        this.victims.countByPriority(),
        this.prisma.triageHistory.count(),
        this.activity.list(50, 0),
      ]);
    const total =
      byPriority.RED + byPriority.YELLOW + byPriority.GREEN + byPriority.BLACK;
    return {
      victims,
      counts: { total, byPriority },
      triageHistoryCount,
      recentActivity,
    };
  }
}
