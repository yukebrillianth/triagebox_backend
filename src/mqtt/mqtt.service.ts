import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { DeviceStatus } from '@prisma/client';
import * as mqtt from 'mqtt';
import { AlertsService } from '../alerts/alerts.service';
import {
  nodeStatusSchema,
  parseTopic,
  stationStatusSchema,
  vitalSchema,
} from '../common/mqtt-payload';
import { NodesService } from '../nodes/nodes.service';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class MqttService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MqttService.name);
  private client: mqtt.MqttClient | null = null;
  private connected = false;
  constructor(
    private readonly prisma: PrismaService,
    private readonly nodesService: NodesService,
    private readonly eventEmitter: EventEmitter2,
    private readonly alerts: AlertsService,
  ) {}

  onModuleInit(): void {
    const brokerUrl = process.env.MQTT_URL ?? 'mqtt://localhost:1883';
    this.logger.log(`Connecting to MQTT broker at ${brokerUrl}`);

    this.client = mqtt.connect(brokerUrl, {
      reconnectPeriod: 1000,
    });
    this.client.on('connect', () => {
      this.connected = true;
      this.logger.log('mqtt connected');
      const topics = [
        'triagebox/+/+/vital',
        'triagebox/+/+/status',
        'triagebox/+/status',
      ];
      this.client?.subscribe(topics, (err) => {
        if (err) {
          this.logger.error(`Failed to subscribe to topics: ${err.message}`);
        } else {
          this.logger.log(`Subscribed to topics: ${topics.join(', ')}`);
        }
      });
    });
    this.client.on('reconnect', () => {
      this.logger.log('Reconnecting to MQTT broker...');
    });
    this.client.on('error', (err) => {
      this.logger.error(`MQTT client error: ${err.message}`);
    });
    this.client.on('close', () => {
      if (this.connected) {
        this.logger.warn('MQTT connection closed');
      }
      this.connected = false;
    });
    this.client.on('message', (topic, payloadBuffer) => {
      this.handleMessage(topic, payloadBuffer).catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.error(`Unhandled error in MQTT message handler: ${msg}`);
      });
    });
  }
  onModuleDestroy(): void {
    if (this.client) {
      this.client.end(true);
      this.client = null;
      this.connected = false;
    }
  }
  isConnected(): boolean {
    return this.connected;
  }
  private async handleMessage(topic: string, payloadBuffer: Buffer): Promise<void> {
    try {
      const parsedTopic = parseTopic(topic);
      if (!parsedTopic) {
        this.logger.warn(`Ignored message on unhandled topic: ${topic}`);
        return;
      }
      const rawText = payloadBuffer.toString('utf-8');
      let json: unknown;
      try {
        json = JSON.parse(rawText);
      } catch {
        this.logger.warn(`Invalid JSON payload received on topic '${topic}': ${rawText}`);
        return;
      }
      if (parsedTopic.kind === 'station_status') {
        await this.handleStationStatus(parsedTopic.stationId, json);
      } else if (parsedTopic.kind === 'node_status') {
        await this.handleNodeStatus(parsedTopic.stationId, parsedTopic.nodeId, json);
      } else if (parsedTopic.kind === 'vital') {
        await this.handleVital(parsedTopic.stationId, parsedTopic.nodeId, json);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`Error processing MQTT topic '${topic}': ${msg}`);
    }
  }
  private async handleStationStatus(stationId: string, json: unknown): Promise<void> {
    const parsed = stationStatusSchema.safeParse(json);
    if (!parsed.success) {
      this.logger.warn(`Invalid station_status payload for station '${stationId}': ${parsed.error.message}`);
      return;
    }
    const station = await this.prisma.station.findUnique({
      where: { id: stationId },
      select: { id: true, status: true },
    });
    if (!station) {
      this.logger.warn(`Received status for unknown station '${stationId}'`);
      return;
    }
    const prev = station.status;
    const next = parsed.data.status as DeviceStatus;
    const lastSeen = new Date();
    await this.prisma.station.update({
      where: { id: stationId },
      data: {
        status: next,
        lastSeen,
      },
    });
    this.eventEmitter.emit('station.status', {
      stationId,
      status: next,
      lastSeen,
    });
    if (next === DeviceStatus.OFFLINE && prev !== DeviceStatus.OFFLINE) {
      await this.alerts.stationOffline(stationId);
    } else if (
      next === DeviceStatus.ONLINE &&
      prev === DeviceStatus.OFFLINE
    ) {
      await this.alerts.stationOnline(stationId);
    }
    this.logger.log(`Updated station '${stationId}' status to ${next}`);
  }
  private async handleNodeStatus(stationId: string, nodeId: string, json: unknown): Promise<void> {
    const parsed = nodeStatusSchema.safeParse(json);
    if (!parsed.success) {
      this.logger.warn(`Invalid node_status payload for node '${nodeId}': ${parsed.error.message}`);
      return;
    }
    const station = await this.prisma.station.findUnique({
      where: { id: stationId },
      select: { id: true },
    });
    if (!station) {
      this.logger.warn(`Received status for node '${nodeId}' under unknown station '${stationId}'`);
      return;
    }
    const node = await this.prisma.node.findUnique({
      where: { id: nodeId },
      select: { id: true, stationId: true, isActive: true, status: true },
    });
    if (!node || node.stationId !== stationId) {
      this.logger.warn(`Received status for unknown node '${nodeId}' or station mismatch`);
      return;
    }
    if (!node.isActive) {
      await this.nodesService.markActive(nodeId);
      this.logger.log(`Reactivated soft-deleted node '${nodeId}'`);
    }
    const prev = node.status;
    const next = parsed.data.status as DeviceStatus;
    const lastSeen = new Date();
    await this.prisma.node.update({
      where: { id: nodeId },
      data: {
        status: next,
        lastSeen,
        ...(parsed.data.rssi !== undefined && { rssi: parsed.data.rssi }),
        ...(parsed.data.snr !== undefined && { snr: parsed.data.snr }),
        ...(parsed.data.battery !== undefined && { battery: parsed.data.battery }),
        ...(parsed.data.firmware !== undefined && { firmware: parsed.data.firmware }),
        ...((parsed.data.packet_count ?? parsed.data.packet_counter) !== undefined && {
          packetCount: (parsed.data.packet_count ?? parsed.data.packet_counter)!,
        }),
      },
    });
    this.eventEmitter.emit('node.status', {
      nodeId,
      status: next,
      battery: parsed.data.battery,
      rssi: parsed.data.rssi,
      snr: parsed.data.snr,
      lastSeen,
    });
    if (next === DeviceStatus.ONLINE && prev === DeviceStatus.OFFLINE) {
      await this.alerts.connectionRestored(nodeId, stationId);
    } else if (
      next === DeviceStatus.OFFLINE &&
      prev === DeviceStatus.ONLINE
    ) {
      await this.alerts.nodeOffline(nodeId, stationId);
    }
    this.logger.log(`Updated node '${nodeId}' status to ${next}`);
  }
  private async handleVital(stationId: string, nodeId: string, json: unknown): Promise<void> {
    const parsed = vitalSchema.safeParse(json);
    if (!parsed.success) {
      this.logger.warn(`Invalid vital payload for node '${nodeId}': ${parsed.error.message}`);
      return;
    }
    const station = await this.prisma.station.findUnique({
      where: { id: stationId },
      select: { id: true },
    });
    if (!station) {
      this.logger.warn(`Received vital for node '${nodeId}' under unknown station '${stationId}'`);
      return;
    }
    const node = await this.prisma.node.findUnique({
      where: { id: nodeId },
      select: { id: true, stationId: true, isActive: true, status: true },
    });
    if (!node || node.stationId !== stationId) {
      this.logger.warn(`Received vital for unknown node '${nodeId}' or station mismatch`);
      return;
    }
    if (!node.isActive) {
      await this.nodesService.markActive(nodeId);
      this.logger.log(`Reactivated soft-deleted node '${nodeId}'`);
    }
    // Vital implies alive: mark ONLINE + restore alert if was OFFLINE.
    const prev = node.status;
    await this.prisma.node.update({
      where: { id: nodeId },
      data: {
        status: DeviceStatus.ONLINE,
        lastSeen: new Date(),
        packetCount: { increment: 1 },
        ...(parsed.data.battery !== undefined && { battery: parsed.data.battery }),
      },
    });
    if (prev === DeviceStatus.OFFLINE) {
      await this.alerts.connectionRestored(nodeId, stationId);
    }
    this.logger.log(`Received vital for node '${nodeId}' (priority: ${parsed.data.priority}, hr: ${parsed.data.hr}, spo2: ${parsed.data.spo2})`);
    this.eventEmitter.emit('mqtt.vital', {
      stationId,
      nodeId,
      payload: parsed.data,
    });
  }
}
