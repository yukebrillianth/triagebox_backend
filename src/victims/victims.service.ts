import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { DeviceStatus, Priority, Prisma, TriageHistory, Victim, VitalReading } from '@prisma/client';
import { ActivityService } from '../activity/activity.service';
import { PrismaService } from '../prisma/prisma.service';
import { UpdateVictimDto } from './dto/update-victim.dto';

export interface VitalDataPayload {
  priority: Priority;
  confidence: number;
  reasons: string[];
  hr?: number;
  spo2?: number;
  rr?: number;
  battery?: number;
}

export interface UpsertVitalResult {
  victim: Victim;
  created: boolean;
  priorityChanged: boolean;
  fromPriority?: Priority;
  toPriority?: Priority;
  /** false when deviceTs/receivedAt is older than existing.lastUpdate */
  snapshotUpdated: boolean;
}

export interface VictimRebindEvent {
  rfid: string;
  oldNodeId: string;
  newNodeId: string;
  victimId: string;
}

export interface VictimQueryFilters {
  search?: string;
  priority?: Priority;
  nodeId?: string;
  sort?: 'lastUpdate_desc' | 'lastUpdate_asc' | 'rfid';
}

@Injectable()
export class VictimsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly activity: ActivityService,
    private readonly eventEmitter: EventEmitter2,
  ) {}
  async upsertFromVital(
    nodeId: string,
    rfid: string | null | undefined,
    vitalData: VitalDataPayload,
    receivedAt = new Date(),
    deviceTs?: Date | null,
  ): Promise<UpsertVitalResult | null> {
    if (!rfid || rfid.trim() === '') {
      return null;
    }
    const trimmedRfid = rfid.trim();
    // Prefer device clock for snapshot freshness; fall back to server receive time.
    const comparisonTime = deviceTs ?? receivedAt;
    const existing = await this.prisma.victim.findUnique({
      where: { rfid: trimmedRfid },
    });
    if (!existing) {
      const victim = await this.prisma.victim.create({
        data: {
          rfid: trimmedRfid,
          currentNodeId: nodeId,
          currentPriority: vitalData.priority,
          confidence: vitalData.confidence,
          reasons: vitalData.reasons as unknown as Prisma.InputJsonValue,
          firstSeen: receivedAt,
          lastUpdate: comparisonTime,
        },
      });
      const node = await this.prisma.node.findUnique({
        where: { id: nodeId },
        select: { id: true },
      });
      if (node) {
        await this.prisma.node.update({
          where: { id: nodeId },
          data: { currentVictimId: victim.id },
        });
      }
      // First-seen RED/BLACK is a critical priority change (no fromPriority).
      const isCritical =
        vitalData.priority === Priority.RED ||
        vitalData.priority === Priority.BLACK;
      return {
        victim,
        created: true,
        priorityChanged: isCritical,
        fromPriority: undefined,
        toPriority: vitalData.priority,
        snapshotUpdated: true,
      };
    }
    // Stale by deviceTs (or receivedAt): keep victim row, still allow VitalReading insert upstream.
    if (
      existing.lastUpdate &&
      existing.lastUpdate.getTime() > comparisonTime.getTime()
    ) {
      return {
        victim: existing,
        created: false,
        priorityChanged: false,
        snapshotUpdated: false,
      };
    }
    let rebindOccurred = false;
    let oldNodeId: string | null = null;
    if (existing.currentNodeId !== nodeId) {
      rebindOccurred = true;
      oldNodeId = existing.currentNodeId;
      if (oldNodeId) {
        await this.prisma.node.updateMany({
          where: {
            id: oldNodeId,
            currentVictimId: existing.id,
          },
          data: { currentVictimId: null },
        });
      }
      const targetNode = await this.prisma.node.findUnique({
        where: { id: nodeId },
        select: { id: true },
      });
      if (targetNode) {
        await this.prisma.node.update({
          where: { id: nodeId },
          data: { currentVictimId: existing.id },
        });
      }
    }
    const priorityChanged = existing.currentPriority !== vitalData.priority;
    const fromPriority = existing.currentPriority ?? undefined;
    const toPriority = vitalData.priority;
    const updatedVictim = await this.prisma.victim.update({
      where: { id: existing.id },
      data: {
        currentNodeId: nodeId,
        currentPriority: vitalData.priority,
        confidence: vitalData.confidence,
        reasons: vitalData.reasons as unknown as Prisma.InputJsonValue,
        lastUpdate: comparisonTime,
      },
    });
    if (rebindOccurred) {
      await this.activity.append(
        'victim_rebind',
        `Victim ${existing.id} (RFID ${trimmedRfid}) rebound to node ${nodeId}${
          oldNodeId ? ` from node ${oldNodeId}` : ''
        }`,
        {
          victimId: existing.id,
          rfid: trimmedRfid,
          previousNodeId: oldNodeId,
          newNodeId: nodeId,
        },
      );
      // duplicateRfid when old node still ONLINE (avoid circular DI via event).
      if (oldNodeId) {
        const oldNode = await this.prisma.node.findUnique({
          where: { id: oldNodeId },
          select: { id: true, status: true },
        });
        if (oldNode?.status === DeviceStatus.ONLINE) {
          this.eventEmitter.emit('victim.rebind', {
            rfid: trimmedRfid,
            oldNodeId,
            newNodeId: nodeId,
            victimId: existing.id,
          } satisfies VictimRebindEvent);
        }
      }
    }
    return {
      victim: updatedVictim,
      created: false,
      priorityChanged,
      fromPriority,
      toPriority,
      snapshotUpdated: true,
    };
  }
  async findAll(filters: VictimQueryFilters): Promise<Victim[]> {
    const where: Prisma.VictimWhereInput = {};
    if (filters.search) {
      const q = filters.search.trim();
      if (q) {
        where.OR = [
          { rfid: { contains: q, mode: 'insensitive' } },
          { name: { contains: q, mode: 'insensitive' } },
        ];
      }
    }
    if (filters.priority) {
      where.currentPriority = filters.priority;
    }
    if (filters.nodeId) {
      where.currentNodeId = filters.nodeId;
    }
    let orderBy: Prisma.VictimOrderByWithRelationInput = { lastUpdate: 'desc' };
    if (filters.sort === 'lastUpdate_asc') {
      orderBy = { lastUpdate: 'asc' };
    } else if (filters.sort === 'rfid') {
      orderBy = { rfid: 'asc' };
    }
    return this.prisma.victim.findMany({
      where,
      orderBy,
    });
  }
  async findOne(id: string): Promise<Victim> {
    const victim = await this.prisma.victim.findUnique({
      where: { id },
    });
    if (!victim) {
      throw new NotFoundException(`Victim '${id}' not found`);
    }
    return victim;
  }
  async update(id: string, dto: UpdateVictimDto): Promise<Victim> {
    await this.findOne(id);
    if (dto.gender !== undefined && dto.gender !== null) {
      if (!['M', 'F', 'U'].includes(dto.gender)) {
        throw new BadRequestException("Gender must be 'M', 'F', 'U', or null");
      }
    }
    return this.prisma.victim.update({
      where: { id },
      data: {
        ...(dto.name !== undefined ? { name: dto.name } : {}),
        ...(dto.age !== undefined ? { age: dto.age } : {}),
        ...(dto.gender !== undefined ? { gender: dto.gender } : {}),
        ...(dto.notes !== undefined ? { notes: dto.notes } : {}),
      },
    });
  }
  async findVitals(id: string, limit = 50): Promise<VitalReading[]> {
    await this.findOne(id);
    const safeLimit = Math.min(Math.max(limit, 1), 100);
    return this.prisma.vitalReading.findMany({
      where: { victimId: id },
      orderBy: { receivedAt: 'desc' },
      take: safeLimit,
    });
  }
  async findTriageHistory(id: string): Promise<TriageHistory[]> {
    await this.findOne(id);
    return this.prisma.triageHistory.findMany({
      where: { victimId: id },
      orderBy: { createdAt: 'desc' },
    });
  }
  async countByPriority(): Promise<Record<Priority, number>> {
    const grouped = await this.prisma.victim.groupBy({
      by: ['currentPriority'],
      _count: { _all: true },
    });
    const counts: Record<Priority, number> = {
      RED: 0,
      YELLOW: 0,
      GREEN: 0,
      BLACK: 0,
    };
    for (const item of grouped) {
      if (item.currentPriority && item.currentPriority in counts) {
        counts[item.currentPriority] = item._count._all;
      }
    }
    return counts;
  }
}
