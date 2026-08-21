import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PendingStation, Station } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AdoptStationDto } from './dto/adopt-station.dto';
import { CreateStationDto } from './dto/create-station.dto';
import { UpdateStationDto } from './dto/update-station.dto';

export type { PendingStation, Station };
export type StationWithNodeCount = Station & { nodeCount: number };

type StationRow = Station & { _count: { nodes: number } };

function withNodeCount({ _count, ...s }: StationRow): StationWithNodeCount {
  return { ...s, nodeCount: _count.nodes };
}

function isPrismaUniqueViolation(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code: string }).code === 'P2002'
  );
}

@Injectable()
export class StationsService {
  constructor(private readonly prisma: PrismaService) {}

  async findAll(includeInactive = false): Promise<StationWithNodeCount[]> {
    const stations = await this.prisma.station.findMany({
      where: includeInactive ? undefined : { isActive: true },
      orderBy: { createdAt: 'asc' },
      include: { _count: { select: { nodes: true } } },
    });
    return stations.map(withNodeCount);
  }

  async findOne(id: string): Promise<StationWithNodeCount> {
    const station = await this.prisma.station.findUnique({
      where: { id },
      include: { _count: { select: { nodes: true } } },
    });
    if (!station) throw new NotFoundException(`Station '${id}' not found`);
    return withNodeCount(station);
  }

  async create(dto: CreateStationDto): Promise<StationWithNodeCount> {
    try {
      const station = await this.prisma.station.create({
        data: {
          id: dto.id,
          name: dto.name,
          firmware: dto.firmware,
          ipAddress: dto.ipAddress,
          mqttBrokerHost: dto.mqttBrokerHost,
          mqttBrokerPort: dto.mqttBrokerPort,
          notes: dto.notes,
        },
        include: { _count: { select: { nodes: true } } },
      });
      return withNodeCount(station);
    } catch (err: unknown) {
      if (isPrismaUniqueViolation(err)) {
        throw new ConflictException(`Station id '${dto.id}' already exists`);
      }
      throw err;
    }
  }

  async update(
    id: string,
    dto: UpdateStationDto,
  ): Promise<StationWithNodeCount> {
    await this.ensureExists(id);
    const station = await this.prisma.station.update({
      where: { id },
      data: {
        name: dto.name,
        firmware: dto.firmware,
        ipAddress: dto.ipAddress,
        mqttBrokerHost: dto.mqttBrokerHost,
        mqttBrokerPort: dto.mqttBrokerPort,
        notes: dto.notes,
      },
      include: { _count: { select: { nodes: true } } },
    });
    return withNodeCount(station);
  }

  async softDelete(id: string): Promise<StationWithNodeCount> {
    await this.ensureExists(id);
    const station = await this.prisma.station.update({
      where: { id },
      data: { isActive: false },
      include: { _count: { select: { nodes: true } } },
    });
    return withNodeCount(station);
  }

  private async ensureExists(id: string): Promise<void> {
    const exists = await this.prisma.station.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!exists) throw new NotFoundException(`Station '${id}' not found`);
  }

  findPending(): Promise<PendingStation[]> {
    return this.prisma.pendingStation.findMany({
      orderBy: { firstSeen: 'asc' },
    });
  }

  /** Record an announce from a station whose id is not registered. */
  upsertPending(data: {
    mac: string;
    announcedStationId: string;
    ip?: string;
    firmware?: string;
    nodeCount?: number;
  }): Promise<PendingStation> {
    const { mac, ...rest } = data;
    return this.prisma.pendingStation.upsert({
      where: { mac },
      create: { mac, ...rest },
      update: rest,
    });
  }

  async dismissPending(mac: string): Promise<PendingStation> {
    const pending = await this.prisma.pendingStation.findUnique({
      where: { mac },
    });
    if (!pending) {
      throw new NotFoundException(`Pending station '${mac}' not found`);
    }
    return this.prisma.pendingStation.delete({ where: { mac } });
  }

  /**
   * Turn a pending candidate into a real Station plus its nodes, in one
   * transaction. `nodeCount` node ids are generated as `node-NN` because that is
   * exactly what the firmware formats from its uint8 radio address -- deriving
   * both from one number is what stops the two sides from disagreeing.
   */
  async adopt(dto: AdoptStationDto): Promise<StationWithNodeCount> {
    const pending = await this.prisma.pendingStation.findUnique({
      where: { mac: dto.mac },
    });
    if (!pending) {
      throw new NotFoundException(`Pending station '${dto.mac}' not found`);
    }
    const nodeCount = dto.nodeCount ?? pending.nodeCount ?? 0;
    const nodeIdBase = dto.nodeIdBase ?? 0;

    try {
      await this.prisma.$transaction([
        this.prisma.station.create({
          data: {
            id: dto.id,
            name: dto.name,
            firmware: pending.firmware,
            ipAddress: pending.ip,
            notes: `Adopted from MAC ${pending.mac}`,
          },
        }),
        ...Array.from({ length: nodeCount }, (_, i) => {
          const n = nodeIdBase + i + 1;
          const id = `node-${String(n).padStart(2, '0')}`;
          return this.prisma.node.create({
            data: { id, stationId: dto.id, name: `Node ${String(n).padStart(2, '0')}` },
          });
        }),
        this.prisma.pendingStation.delete({ where: { mac: dto.mac } }),
      ]);
    } catch (err: unknown) {
      if (isPrismaUniqueViolation(err)) {
        throw new ConflictException(
          `Station '${dto.id}' or one of its node ids already exists`,
        );
      }
      throw err;
    }
    return this.findOne(dto.id);
  }
}
