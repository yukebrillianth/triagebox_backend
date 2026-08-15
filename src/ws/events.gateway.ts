import { Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import {
  OnGatewayConnection,
  OnGatewayDisconnect,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import type { Alert, Priority, Victim } from '@prisma/client';
import type { Server, Socket } from 'socket.io';
import type {
  PriorityChangedEvent,
  VictimCreatedEvent,
  VitalIngestedEvent,
} from '../alerts/alerts.service';
import { PrismaService } from '../prisma/prisma.service';
import { VictimsService } from '../victims/victims.service';

export interface NodeStatusEvent {
  nodeId: string;
  status: string;
  battery?: number | null;
  rssi?: number | null;
  snr?: number | null;
  lastSeen: Date | string;
}

export interface StationStatusEvent {
  stationId: string;
  status: string;
  lastSeen: Date | string;
}

function corsOrigin(): string | string[] | boolean {
  const raw = process.env.CORS_ORIGIN ?? '*';
  if (raw === '*') return true;
  if (raw.includes(',')) return raw.split(',').map((s) => s.trim());
  return raw;
}

@WebSocketGateway({ cors: { origin: corsOrigin() } })
export class EventsGateway
  implements OnGatewayConnection, OnGatewayDisconnect
{
  private readonly logger = new Logger(EventsGateway.name);

  @WebSocketServer()
  server!: Server;

  constructor(
    private readonly prisma: PrismaService,
    private readonly victims: VictimsService,
  ) {}

  handleConnection(client: Socket): void {
    this.logger.log(`WS client connected ${client.id}`);
  }

  handleDisconnect(client: Socket): void {
    this.logger.log(`WS client disconnected ${client.id}`);
  }

  private broadcast(event: string, payload: unknown): void {
    this.server?.emit(event, payload);
  }

  private async emitKpi(): Promise<void> {
    const byPriority = await this.victims.countByPriority();
    const total =
      byPriority.RED +
      byPriority.YELLOW +
      byPriority.GREEN +
      byPriority.BLACK;
    this.broadcast('kpi.updated', { total, byPriority });
  }

  @OnEvent('victim.created')
  onVictimCreated(event: VictimCreatedEvent): void {
    this.broadcast('victim.created', event.victim);
    void this.emitKpi();
  }

  @OnEvent('victim.updated')
  onVictimUpdated(event: { victim: Victim }): void {
    this.broadcast('victim.updated', event.victim);
  }

  @OnEvent('priority.changed')
  onPriorityChanged(event: PriorityChangedEvent): void {
    this.broadcast('victim.priority_changed', {
      victimId: event.victimId,
      rfid: event.rfid,
      from: event.fromPriority,
      to: event.toPriority,
      confidence: event.confidence,
      reasons: event.reasons,
      nodeId: event.nodeId,
    });
    void this.emitKpi();
  }

  @OnEvent('vital.ingested')
  async onVitalIngested(event: VitalIngestedEvent): Promise<void> {
    const reading = await this.prisma.vitalReading.findUnique({
      where: { id: event.vitalReadingId },
    });
    if (!reading) return;
    this.broadcast('vital.updated', {
      victimId: reading.victimId,
      nodeId: reading.nodeId,
      hr: reading.hr,
      spo2: reading.spo2,
      rr: reading.rr,
      bpSys: reading.bpSys ?? undefined,
      bpDia: reading.bpDia ?? undefined,
      battery: reading.battery,
      priority: reading.priority as Priority | string,
      ts: reading.receivedAt,
    });
  }

  @OnEvent('node.status')
  onNodeStatus(event: NodeStatusEvent): void {
    this.broadcast('node.status', event);
  }

  @OnEvent('station.status')
  onStationStatus(event: StationStatusEvent): void {
    this.broadcast('station.status', event);
  }

  @OnEvent('alert.created')
  onAlertCreated(alert: Alert): void {
    this.broadcast('alert.created', alert);
  }

  @OnEvent('activity.created')
  onActivityCreated(activity: unknown): void {
    this.broadcast('activity.created', activity);
  }
}
