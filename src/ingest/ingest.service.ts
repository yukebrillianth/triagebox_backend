import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2, OnEvent } from '@nestjs/event-emitter';
import { DeviceStatus, Priority, Prisma } from '@prisma/client';
import { ActivityService } from '../activity/activity.service';
import { parseDeviceTs, type VitalPayload } from '../common/mqtt-payload';
import { NodesService } from '../nodes/nodes.service';
import { PrismaService } from '../prisma/prisma.service';
import { VictimsService } from '../victims/victims.service';

export interface MqttVitalEvent {
  stationId: string;
  nodeId: string;
  payload: VitalPayload;
}

@Injectable()
export class IngestService {
  private readonly logger = new Logger(IngestService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly nodesService: NodesService,
    private readonly victimsService: VictimsService,
    private readonly activity: ActivityService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  @OnEvent('mqtt.vital')
  async handleMqttVital(event: MqttVitalEvent): Promise<void> {
    try {
      await this.ingestVital(event);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(
        `Ingest failed for node '${event.nodeId}': ${msg}`,
      );
    }
  }

  private async ingestVital(event: MqttVitalEvent): Promise<void> {
    const { stationId, nodeId, payload } = event;
    const receivedAt = new Date();
    const deviceTs = parseDeviceTs(payload.ts);

    const node = await this.prisma.node.findUnique({
      where: { id: nodeId },
      select: { id: true, stationId: true, isActive: true },
    });
    if (!node || node.stationId !== stationId) {
      this.logger.warn(
        `Drop vital: unknown node '${nodeId}' or station mismatch`,
      );
      return;
    }

    const station = await this.prisma.station.findUnique({
      where: { id: stationId },
      select: { id: true, isActive: true },
    });
    if (!station || !station.isActive) {
      this.logger.warn(
        `Drop vital: unknown or inactive station '${stationId}'`,
      );
      return;
    }

    if (!node.isActive) {
      await this.nodesService.markActive(nodeId);
    }

    const rfid = payload.victim_rfid;
    if (rfid == null || rfid.trim() === '') {
      // Heartbeat without RFID: still ONLINE + lastSeen (defense in depth vs mqtt path).
      await this.prisma.node.update({
        where: { id: nodeId },
        data: {
          status: DeviceStatus.ONLINE,
          lastSeen: receivedAt,
          // `!= null`, not `!== undefined`: a vital may now carry battery: null
          // (gauge not read), and writing that would wipe a valid node reading.
          ...(payload.battery != null && { battery: payload.battery }),
        },
      });
      return;
    }

    const vitalData = {
      priority: payload.priority as Priority,
      confidence: payload.confidence,
      reasons: payload.reasons,
      hr: payload.hr,
      spo2: payload.spo2,
      rr: payload.rr,
      battery: payload.battery,
    };

    // 1) Victim snapshot (may skip update if stale by deviceTs).
    const upsert = await this.victimsService.upsertFromVital(
      nodeId,
      rfid,
      vitalData,
      receivedAt,
      deviceTs,
    );
    if (!upsert) {
      return;
    }

    // 2) Always insert VitalReading + node ONLINE touch in one transaction.
    //    Optional TriageHistory only on real priority transitions (fromPriority defined).
    const historyData =
      upsert.priorityChanged &&
      upsert.fromPriority &&
      upsert.toPriority
        ? {
            victimId: upsert.victim.id,
            fromPriority: upsert.fromPriority,
            toPriority: upsert.toPriority,
            confidence: payload.confidence,
            reasons: payload.reasons as unknown as Prisma.InputJsonValue,
            nodeId,
          }
        : null;

    const [vitalReading] = await this.prisma.$transaction([
      this.prisma.vitalReading.create({
        data: {
          victimId: upsert.victim.id,
          nodeId,
          hr: payload.hr,
          spo2: payload.spo2,
          rr: payload.rr,
          bpSys: payload.bp_sys ?? null,
          bpDia: payload.bp_dia ?? null,
          battery: payload.battery,
          priority: payload.priority as Priority,
          confidence: payload.confidence,
          reasons: payload.reasons as unknown as Prisma.InputJsonValue,
          ecgStatus: payload.ecg_status ?? null,
          deviceStatus: payload.device_status ?? null,
          deviceTs,
          receivedAt,
        },
      }),
      this.prisma.node.update({
        where: { id: nodeId },
        data: {
          status: DeviceStatus.ONLINE,
          lastSeen: receivedAt,
          currentVictimId: upsert.victim.id,
          ...(payload.battery != null && { battery: payload.battery }),
        },
      }),
      ...(historyData
        ? [this.prisma.triageHistory.create({ data: historyData })]
        : []),
    ]);

    if (
      upsert.priorityChanged &&
      upsert.fromPriority &&
      upsert.toPriority
    ) {
      await this.activity.append(
        'priority_changed',
        `Victim ${upsert.victim.id} (RFID ${upsert.victim.rfid}) ${upsert.fromPriority}→${upsert.toPriority}`,
        {
          victimId: upsert.victim.id,
          rfid: upsert.victim.rfid,
          fromPriority: upsert.fromPriority,
          toPriority: upsert.toPriority,
          nodeId,
          confidence: payload.confidence,
        },
      );
      this.eventEmitter.emit('priority.changed', {
        victimId: upsert.victim.id,
        rfid: upsert.victim.rfid,
        fromPriority: upsert.fromPriority,
        toPriority: upsert.toPriority,
        confidence: payload.confidence,
        reasons: payload.reasons,
        nodeId,
        stationId,
      });
    }

    this.eventEmitter.emit(
      upsert.created ? 'victim.created' : 'victim.updated',
      {
        victim: upsert.victim,
        nodeId,
        stationId,
        created: upsert.created,
      },
    );

    this.eventEmitter.emit('vital.ingested', {
      vitalReadingId: vitalReading.id,
      victimId: upsert.victim.id,
      nodeId,
      stationId,
      priority: payload.priority,
      receivedAt,
    });

    this.logger.log(
      `Ingested vital for RFID ${upsert.victim.rfid} on node '${nodeId}' (${payload.priority})${
        upsert.snapshotUpdated ? '' : ' [stale snapshot]'
      }`,
    );
  }
}
