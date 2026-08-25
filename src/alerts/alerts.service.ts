import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { EventEmitter2, OnEvent } from '@nestjs/event-emitter';
import { Alert, AlertSeverity, Priority, Prisma, Victim } from '@prisma/client';
import { ActivityService } from '../activity/activity.service';
import { PrismaService } from '../prisma/prisma.service';

export interface PriorityChangedEvent {
  victimId: string;
  rfid: string;
  fromPriority: Priority;
  toPriority: Priority;
  confidence: number;
  reasons: string[];
  nodeId: string;
  stationId: string;
}

export interface VictimCreatedEvent {
  victim: Victim;
  nodeId: string;
  stationId: string;
  created: boolean;
}

export interface VitalIngestedEvent {
  vitalReadingId: string;
  victimId: string;
  nodeId: string;
  stationId: string;
  priority: Priority | string;
  receivedAt: Date;
}

const OFFLINE_COOLDOWN_MS = 30_000;
const DUPLICATE_RFID_DEDUP_MS = 5 * 60_000;

@Injectable()
export class AlertsService {
  private readonly logger = new Logger(AlertsService.name);
  // ponytail: in-memory edge maps OK for single-process demo; persist last state if multi-instance.
  private readonly batteryWasLow = new Map<string, boolean>();
  private readonly lastOfflineAlertAt = new Map<string, number>();
  private readonly lastDuplicateRfidAt = new Map<string, number>();
  private readonly batteryLowPct: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly activity: ActivityService,
    private readonly eventEmitter: EventEmitter2,
  ) {
    this.batteryLowPct = Number(process.env.BATTERY_LOW_PCT ?? 20);
  }

  list(filters: {
    severity?: AlertSeverity;
    acked?: boolean;
    limit?: number;
  }): Promise<Alert[]> {
    const take = filters.limit ?? 50;
    return this.prisma.alert.findMany({
      where: {
        ...(filters.severity ? { severity: filters.severity } : {}),
        ...(filters.acked !== undefined
          ? { acknowledged: filters.acked }
          : {}),
      },
      orderBy: { createdAt: 'desc' },
      take,
    });
  }

  async ack(id: string): Promise<Alert> {
    const existing = await this.prisma.alert.findUnique({ where: { id } });
    if (!existing) {
      throw new NotFoundException(`Alert '${id}' not found`);
    }
    if (existing.acknowledged) {
      return existing;
    }
    return this.prisma.alert.update({
      where: { id },
      data: { acknowledged: true },
    });
  }

  @OnEvent('victim.created')
  async onVictimCreated(event: VictimCreatedEvent): Promise<void> {
    const { victim, nodeId, stationId } = event;
    const isCritical =
      victim.currentPriority === Priority.RED ||
      victim.currentPriority === Priority.BLACK;
    if (isCritical) {
      // First-seen RED/BLACK → CRITICAL (no TriageHistory without fromPriority).
      await this.createAlert({
        severity: AlertSeverity.CRITICAL,
        type: 'new_critical_victim',
        message: `New CRITICAL victim RFID ${victim.rfid} · Node ${nodeId} · ${victim.currentPriority}`,
        victimId: victim.id,
        nodeId,
        stationId,
        payload: {
          rfid: victim.rfid,
          priority: victim.currentPriority,
        },
      });
      return;
    }
    await this.createAlert({
      severity: AlertSeverity.INFO,
      type: 'new_victim',
      message: `New victim RFID ${victim.rfid} on node ${nodeId}`,
      victimId: victim.id,
      nodeId,
      stationId,
      payload: { rfid: victim.rfid },
    });
  }

  @OnEvent('victim.rebind')
  async onVictimRebind(event: {
    rfid: string;
    oldNodeId: string;
    newNodeId: string;
    victimId: string;
  }): Promise<void> {
    await this.duplicateRfid(
      event.rfid,
      event.newNodeId,
      event.oldNodeId,
      event.victimId,
    );
  }

  @OnEvent('priority.changed')
  async onPriorityChanged(event: PriorityChangedEvent): Promise<void> {
    const { rfid, fromPriority, toPriority, nodeId, stationId, victimId } =
      event;
    const severity =
      toPriority === Priority.RED
        ? AlertSeverity.CRITICAL
        : AlertSeverity.WARNING;
    await this.createAlert({
      severity,
      type: 'priority_changed',
      message: `Victim RFID ${rfid} · Node ${nodeId} · ${fromPriority} → ${toPriority}`,
      victimId,
      nodeId,
      stationId,
      payload: {
        rfid,
        fromPriority,
        toPriority,
        confidence: event.confidence,
        reasons: event.reasons,
      },
    });
  }

  @OnEvent('vital.ingested')
  async onVitalIngested(event: VitalIngestedEvent): Promise<void> {
    const reading = await this.prisma.vitalReading.findUnique({
      where: { id: event.vitalReadingId },
      select: { battery: true },
    });
    if (!reading) return;
    /* No reading, no edge. `null < batteryLowPct` coerces to 0 < 20 and would
     * fire a low-battery alert on every vital whose gauge had not reported yet --
     * every node for its first cycles after boot, and forever on any node whose
     * PMIC read keeps failing. */
    if (reading.battery === null) return;
    await this.handleBatteryEdge(
      event.nodeId,
      event.stationId,
      event.victimId,
      reading.battery,
    );
  }

  /** Edge: fire only when battery crosses BATTERY_LOW_PCT. */
  async handleBatteryEdge(
    nodeId: string,
    stationId: string | undefined,
    victimId: string | undefined,
    battery: number,
  ): Promise<void> {
    const isLow = battery < this.batteryLowPct;
    const prev = this.batteryWasLow.get(nodeId);

    if (prev === undefined) {
      this.batteryWasLow.set(nodeId, isLow);
      if (isLow) {
        await this.batteryLow(nodeId, stationId, victimId, battery);
      }
      return;
    }

    if (!prev && isLow) {
      await this.batteryLow(nodeId, stationId, victimId, battery);
    } else if (prev && !isLow) {
      await this.batteryRestored(nodeId, stationId, victimId, battery);
    }
    this.batteryWasLow.set(nodeId, isLow);
  }

  async batteryLow(
    nodeId: string,
    stationId?: string,
    victimId?: string,
    battery?: number,
  ): Promise<Alert> {
    return this.createAlert({
      severity: AlertSeverity.WARNING,
      type: 'battery_low',
      message: `Node ${nodeId} battery low${battery !== undefined ? ` (${battery}%)` : ''}`,
      nodeId,
      stationId,
      victimId,
      payload: { battery, threshold: this.batteryLowPct },
    });
  }

  async batteryRestored(
    nodeId: string,
    stationId?: string,
    victimId?: string,
    battery?: number,
  ): Promise<Alert> {
    return this.createAlert({
      severity: AlertSeverity.INFO,
      type: 'battery_restored',
      message: `Node ${nodeId} battery restored${battery !== undefined ? ` (${battery}%)` : ''}`,
      nodeId,
      stationId,
      victimId,
      payload: { battery, threshold: this.batteryLowPct },
    });
  }

  /** T10: offline scanner. 30s cooldown per node. */
  async nodeOffline(nodeId: string, stationId?: string): Promise<Alert | null> {
    const now = Date.now();
    const last = this.lastOfflineAlertAt.get(nodeId) ?? 0;
    if (now - last < OFFLINE_COOLDOWN_MS) {
      this.logger.debug(`nodeOffline cooldown skip for ${nodeId}`);
      return null;
    }
    this.lastOfflineAlertAt.set(nodeId, now);
    return this.createAlert({
      severity: AlertSeverity.WARNING,
      type: 'node_offline',
      message: `Node ${nodeId} offline`,
      nodeId,
      stationId,
    });
  }

  /** T10: first ONLINE after OFFLINE. */
  async connectionRestored(
    nodeId: string,
    stationId?: string,
  ): Promise<Alert> {
    return this.createAlert({
      severity: AlertSeverity.INFO,
      type: 'connection_restored',
      message: `Node ${nodeId} connection restored`,
      nodeId,
      stationId,
    });
  }

  /** T10: station LWT/status OFFLINE. */
  async stationOffline(stationId: string): Promise<Alert> {
    return this.createAlert({
      severity: AlertSeverity.CRITICAL,
      type: 'station_offline',
      message: `Station ${stationId} offline`,
      stationId,
    });
  }

  /** T10: station heartbeat after offline. */
  async stationOnline(stationId: string): Promise<Alert> {
    return this.createAlert({
      severity: AlertSeverity.INFO,
      type: 'station_online',
      message: `Station ${stationId} online`,
      stationId,
    });
  }

  /** Optional from victims: same rfid on 2 nodes. 5-min dedup. */
  async duplicateRfid(
    rfid: string,
    nodeId: string,
    otherNodeId?: string,
    victimId?: string,
    stationId?: string,
  ): Promise<Alert | null> {
    const key = `${rfid}:${nodeId}:${otherNodeId ?? ''}`;
    const now = Date.now();
    const last = this.lastDuplicateRfidAt.get(key) ?? 0;
    if (now - last < DUPLICATE_RFID_DEDUP_MS) {
      return null;
    }
    this.lastDuplicateRfidAt.set(key, now);
    return this.createAlert({
      severity: AlertSeverity.WARNING,
      type: 'duplicate_rfid',
      message: otherNodeId
        ? `Duplicate RFID ${rfid} on nodes ${otherNodeId} and ${nodeId}`
        : `Duplicate RFID ${rfid} on node ${nodeId}`,
      victimId,
      nodeId,
      stationId,
      payload: { rfid, nodeId, otherNodeId },
    });
  }

  private async createAlert(input: {
    severity: AlertSeverity;
    type: string;
    message: string;
    victimId?: string;
    nodeId?: string;
    stationId?: string;
    payload?: Record<string, unknown>;
  }): Promise<Alert> {
    const alert = await this.prisma.alert.create({
      data: {
        severity: input.severity,
        type: input.type,
        message: input.message,
        victimId: input.victimId,
        nodeId: input.nodeId,
        stationId: input.stationId,
        payload: input.payload !== undefined
          ? (input.payload as Prisma.InputJsonValue)
          : undefined,
      },
    });
    await this.activity.append(input.type, input.message, {
      alertId: alert.id,
      victimId: input.victimId,
      nodeId: input.nodeId,
      stationId: input.stationId,
    });
    this.eventEmitter.emit('alert.created', alert);
    this.logger.log(`Alert ${input.type} [${input.severity}] ${input.message}`);
    return alert;
  }
}
