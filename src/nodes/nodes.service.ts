import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { DeviceStatus, Node, Priority, Station } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CreateNodeDto } from './dto/create-node.dto';
import { UpdateNodeDto } from './dto/update-node.dto';

export type { Node };

export type VictimSummary = {
  id: string;
  rfid: string;
  name: string | null;
  priority: Priority | null;
};

export type NodeResponse = Node & {
  station: Station;
  currentVictim: VictimSummary | null;
};

type NodeWithStation = Node & { station: Station };

function isPrismaUniqueViolation(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code: string }).code === 'P2002'
  );
}

@Injectable()
export class NodesService {
  constructor(private readonly prisma: PrismaService) {}

  async findAll(filters: {
    stationId?: string;
    status?: DeviceStatus;
    includeInactive?: boolean;
  }): Promise<NodeResponse[]> {
    const nodes = await this.prisma.node.findMany({
      where: {
        ...(filters.includeInactive ? {} : { isActive: true }),
        ...(filters.stationId ? { stationId: filters.stationId } : {}),
        ...(filters.status ? { status: filters.status } : {}),
      },
      orderBy: { createdAt: 'asc' },
      include: { station: true },
    });
    return this.attachVictims(nodes);
  }

  async findOne(id: string): Promise<NodeResponse> {
    const node = await this.prisma.node.findUnique({
      where: { id },
      include: { station: true },
    });
    if (!node) throw new NotFoundException(`Node '${id}' not found`);
    const [mapped] = await this.attachVictims([node]);
    return mapped;
  }

  async create(dto: CreateNodeDto): Promise<NodeResponse> {
    await this.ensureStationActive(dto.stationId);
    try {
      const node = await this.prisma.node.create({
        data: {
          id: dto.id,
          stationId: dto.stationId,
          name: dto.name,
          firmware: dto.firmware,
        },
        include: { station: true },
      });
      return { ...node, currentVictim: null };
    } catch (err: unknown) {
      if (isPrismaUniqueViolation(err)) {
        throw new ConflictException(`Node id '${dto.id}' already exists`);
      }
      throw err;
    }
  }

  async update(id: string, dto: UpdateNodeDto): Promise<NodeResponse> {
    await this.ensureExists(id);
    if (dto.stationId) await this.ensureStationActive(dto.stationId);
    const node = await this.prisma.node.update({
      where: { id },
      data: {
        name: dto.name,
        firmware: dto.firmware,
        stationId: dto.stationId,
      },
      include: { station: true },
    });
    const [mapped] = await this.attachVictims([node]);
    return mapped;
  }

  async softDelete(id: string): Promise<NodeResponse> {
    await this.ensureExists(id);
    const node = await this.prisma.node.update({
      where: { id },
      data: { isActive: false },
      include: { station: true },
    });
    const [mapped] = await this.attachVictims([node]);
    return mapped;
  }

  async markActive(nodeId: string): Promise<NodeResponse> {
    await this.ensureExists(nodeId);
    const node = await this.prisma.node.update({
      where: { id: nodeId },
      data: { isActive: true },
      include: { station: true },
    });
    const [mapped] = await this.attachVictims([node]);
    return mapped;
  }

  private async ensureExists(id: string): Promise<void> {
    const exists = await this.prisma.node.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!exists) throw new NotFoundException(`Node '${id}' not found`);
  }

  private async ensureStationActive(stationId: string): Promise<void> {
    const station = await this.prisma.station.findUnique({
      where: { id: stationId },
      select: { id: true, isActive: true },
    });
    if (!station || !station.isActive) {
      throw new BadRequestException(
        `Station '${stationId}' is missing or inactive`,
      );
    }
  }

  private async attachVictims(
    nodes: NodeWithStation[],
  ): Promise<NodeResponse[]> {
    const victimIds = [
      ...new Set(
        nodes
          .map((n) => n.currentVictimId)
          .filter((id): id is string => id != null),
      ),
    ];
    const victims =
      victimIds.length === 0
        ? []
        : await this.prisma.victim.findMany({
            where: { id: { in: victimIds } },
            select: {
              id: true,
              rfid: true,
              name: true,
              currentPriority: true,
            },
          });
    const byId = new Map(
      victims.map((v) => [
        v.id,
        {
          id: v.id,
          rfid: v.rfid,
          name: v.name,
          priority: v.currentPriority,
        } satisfies VictimSummary,
      ]),
    );
    return nodes.map((n) => ({
      ...n,
      currentVictim: n.currentVictimId
        ? (byId.get(n.currentVictimId) ?? null)
        : null,
    }));
  }
}
