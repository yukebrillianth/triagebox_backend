import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Interval } from '@nestjs/schedule';
import { DeviceStatus } from '@prisma/client';
import { AlertsService } from '../alerts/alerts.service';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class OfflineService {
  private readonly logger = new Logger(OfflineService.name);
  private readonly offlineSec: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly alerts: AlertsService,
    private readonly eventEmitter: EventEmitter2,
  ) {
    this.offlineSec = Number(process.env.NODE_OFFLINE_SEC ?? 45);
  }

  @Interval(15_000)
  async scanOfflineNodes(): Promise<void> {
    const cutoff = new Date(Date.now() - this.offlineSec * 1000);
    const stale = await this.prisma.node.findMany({
      where: {
        isActive: true,
        status: DeviceStatus.ONLINE,
        lastSeen: { lt: cutoff },
      },
      select: {
        id: true,
        stationId: true,
        battery: true,
        rssi: true,
        snr: true,
        lastSeen: true,
      },
    });
    if (stale.length === 0) return;

    for (const node of stale) {
      await this.prisma.node.update({
        where: { id: node.id },
        data: { status: DeviceStatus.OFFLINE },
      });
      this.eventEmitter.emit('node.status', {
        nodeId: node.id,
        status: DeviceStatus.OFFLINE,
        battery: node.battery,
        rssi: node.rssi,
        snr: node.snr,
        lastSeen: node.lastSeen,
      });
      await this.alerts.nodeOffline(node.id, node.stationId);
      this.logger.warn(
        `Node '${node.id}' marked OFFLINE (lastSeen < ${this.offlineSec}s)`,
      );
    }
  }
}
