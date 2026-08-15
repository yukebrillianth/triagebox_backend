import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Station } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CreateStationDto } from './dto/create-station.dto';
import { UpdateStationDto } from './dto/update-station.dto';

export type { Station };
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
}
