import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  DeviceStatus,
  Priority,
  Prisma,
  TriageHistory,
  TriageSource,
  Victim,
  VictimStatus,
  VitalReading,
} from '@prisma/client';
import { ActivityService } from '../activity/activity.service';
import { PrismaService } from '../prisma/prisma.service';
import { OverrideVictimDto } from './dto/override-victim.dto';
import { UpdateVictimDto } from './dto/update-victim.dto';
import { toVictimView, VictimView } from './victim-view';

export interface VitalDataPayload {
  priority: Priority;
  /** null when the node reported no confidence for this reading. */
  confidence: number | null;
  reasons: string[];
  hr?: number | null;
  spo2?: number | null;
  rr?: number | null;
  battery?: number | null;
  /**
   * Operator facts, not measurements: age in years and 'M'/'F'. null when the
   * device never asked, which is most readings -- so they are only ever written,
   * never blanked (see upsertFromVital).
   */
  age?: number | null;
  gender?: string | null;
  /** Latched blood pressure from the node; see bpMeasuredAt on Victim. */
  bpSys?: number | null;
  bpDia?: number | null;
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
  status?: VictimStatus;
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
          devicePriority: vitalData.priority,
          ...(vitalData.bpSys != null &&
            vitalData.bpDia != null && { bpMeasuredAt: receivedAt }),
          confidence: vitalData.confidence,
          reasons: vitalData.reasons as unknown as Prisma.InputJsonValue,
          // `!= null`, not `!== undefined`: the device omits age/gender until the
          // operator answers, and the column's own null already says "unknown".
          ...(vitalData.age != null && { age: vitalData.age }),
          ...(vitalData.gender != null && { gender: vitalData.gender }),
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
    // The DEVICE's previous category, not the displayed one: while an operator
    // override stands, currentPriority is the person's decision, and a node that
    // keeps saying something else must still register as a device transition (a
    // device-side deterioration to RED must raise its alert whatever was typed).
    const previousDevice = existing.devicePriority ?? existing.currentPriority;
    const priorityChanged = previousDevice !== vitalData.priority;
    const fromPriority = previousDevice ?? undefined;
    const toPriority = vitalData.priority;
    const overrideStanding = existing.overridePriority != null;
    const bpChanged = await this.bloodPressureChanged(existing.id, vitalData);
    const reactivated = existing.status !== VictimStatus.ACTIVE;
    const updatedVictim = await this.prisma.victim.update({
      where: { id: existing.id },
      data: {
        currentNodeId: nodeId,
        devicePriority: vitalData.priority,
        // Never overwritten while an override stands; the dashboard shows the
        // disagreement (deviceDiffersFromOperator) instead of hiding it.
        ...(!overrideStanding && { currentPriority: vitalData.priority }),
        ...(bpChanged && { bpMeasuredAt: receivedAt }),
        // A live reading means the patient is on a node: never leave them hidden
        // in a non-active list because somebody once marked them referred.
        ...(reactivated && {
          status: VictimStatus.ACTIVE,
          statusChangedBy: 'device',
        }),
        confidence: vitalData.confidence,
        reasons: vitalData.reasons as unknown as Prisma.InputJsonValue,
        // Write-only, never blank: the operator answers the Age screen once and
        // every later reading omits the keys. `!== undefined` here would wipe an
        // answered age back to unknown four times a minute. An operator PATCH is
        // the way to correct one.
        ...(vitalData.age != null && { age: vitalData.age }),
        ...(vitalData.gender != null && { gender: vitalData.gender }),
        lastUpdate: comparisonTime,
      },
    });
    if (reactivated) {
      await this.activity.append(
        'victim_reactivated',
        `Victim ${existing.id} (RFID ${trimmedRfid}) back to ACTIVE: new reading from node ${nodeId} (was ${existing.status})`,
        { victimId: existing.id, rfid: trimmedRfid, previousStatus: existing.status },
      );
    }
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
  async findAll(filters: VictimQueryFilters): Promise<VictimView[]> {
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
    if (filters.status) {
      where.status = filters.status;
    }
    let orderBy: Prisma.VictimOrderByWithRelationInput = { lastUpdate: 'desc' };
    if (filters.sort === 'lastUpdate_asc') {
      orderBy = { lastUpdate: 'asc' };
    } else if (filters.sort === 'rfid') {
      orderBy = { rfid: 'asc' };
    }
    const rows = await this.prisma.victim.findMany({ where, orderBy });
    return rows.map((v) => toVictimView(v, false));
  }

  /** The detail view: the only one that carries the full NIK. */
  async findOne(id: string): Promise<VictimView> {
    return toVictimView(await this.getRaw(id), true);
  }

  private async getRaw(id: string): Promise<Victim> {
    const victim = await this.prisma.victim.findUnique({
      where: { id },
    });
    if (!victim) {
      throw new NotFoundException(`Victim '${id}' not found`);
    }
    return victim;
  }

  async update(id: string, dto: UpdateVictimDto): Promise<VictimView> {
    const before = await this.getRaw(id);
    if (dto.gender !== undefined && dto.gender !== null) {
      if (!['M', 'F', 'U'].includes(dto.gender)) {
        throw new BadRequestException("Gender must be 'M', 'F', 'U', or null");
      }
    }
    const statusChanging =
      dto.status !== undefined && dto.status !== before.status;
    const updated = await this.prisma.victim.update({
      where: { id },
      data: {
        ...(dto.name !== undefined ? { name: dto.name } : {}),
        ...(dto.age !== undefined ? { age: dto.age } : {}),
        ...(dto.gender !== undefined ? { gender: dto.gender } : {}),
        ...(dto.notes !== undefined ? { notes: dto.notes } : {}),
        ...(dto.nik !== undefined ? { nik: dto.nik } : {}),
        ...(dto.address !== undefined ? { address: dto.address } : {}),
        ...(dto.familyContactName !== undefined
          ? { familyContactName: dto.familyContactName }
          : {}),
        ...(dto.familyContactPhone !== undefined
          ? { familyContactPhone: dto.familyContactPhone }
          : {}),
        ...(dto.chiefComplaint !== undefined
          ? { chiefComplaint: dto.chiefComplaint }
          : {}),
        ...(dto.referralDestination !== undefined
          ? { referralDestination: dto.referralDestination }
          : {}),
        ...(statusChanging
          ? {
              status: dto.status,
              statusChangedBy: dto.statusChangedBy ?? 'operator',
              ...(dto.status === VictimStatus.REFERRED && {
                referredAt: new Date(),
              }),
            }
          : dto.statusChangedBy !== undefined
            ? { statusChangedBy: dto.statusChangedBy }
            : {}),
      },
    });
    if (statusChanging) {
      // No NIK, name or address in the log line: ids and the status only.
      await this.activity.append(
        'victim_status_changed',
        `Victim ${updated.id} (RFID ${updated.rfid}) ${before.status}→${updated.status}`,
        { victimId: updated.id, rfid: updated.rfid, from: before.status, to: updated.status },
      );
    }
    this.eventEmitter.emit('victim.updated', { victim: updated });
    return toVictimView(updated, true);
  }

  /**
   * A person at the post sets the category. It becomes the displayed one and
   * stays so: later node readings update devicePriority, not currentPriority,
   * and the view flags the disagreement. The reason is the audit trail.
   */
  async override(id: string, dto: OverrideVictimDto): Promise<VictimView> {
    const reason = dto.reason.trim();
    if (reason === '') {
      throw new BadRequestException('reason must not be empty');
    }
    const before = await this.getRaw(id);
    const from = before.currentPriority ?? dto.priority;
    const now = new Date();
    const [updated] = await this.prisma.$transaction([
      this.prisma.victim.update({
        where: { id },
        data: {
          currentPriority: dto.priority,
          overridePriority: dto.priority,
          overrideReason: reason,
          overrideAt: now,
          lastUpdate: now,
        },
      }),
      this.prisma.triageHistory.create({
        data: {
          victimId: id,
          fromPriority: from,
          toPriority: dto.priority,
          source: TriageSource.OPERATOR,
          reason,
          nodeId: before.currentNodeId,
        },
      }),
    ]);
    await this.activity.append(
      'priority_overridden',
      `Victim ${id} (RFID ${before.rfid}) ${from}→${dto.priority} by operator`,
      { victimId: id, rfid: before.rfid, fromPriority: from, toPriority: dto.priority },
    );
    this.eventEmitter.emit('victim.updated', { victim: updated });
    return toVictimView(updated, true);
  }

  /** True when the node's latched blood pressure differs from the last stored one. */
  private async bloodPressureChanged(
    victimId: string,
    vital: VitalDataPayload,
  ): Promise<boolean> {
    if (vital.bpSys == null || vital.bpDia == null) {
      return false;
    }
    const last = await this.prisma.vitalReading.findFirst({
      where: { victimId, bpSys: { not: null } },
      orderBy: { receivedAt: 'desc' },
      select: { bpSys: true, bpDia: true },
    });
    return !last || last.bpSys !== vital.bpSys || last.bpDia !== vital.bpDia;
  }
  async findVitals(id: string, limit = 50): Promise<VitalReading[]> {
    await this.getRaw(id);
    const safeLimit = Math.min(Math.max(limit, 1), 100);
    return this.prisma.vitalReading.findMany({
      where: { victimId: id },
      orderBy: { receivedAt: 'desc' },
      take: safeLimit,
    });
  }
  async findTriageHistory(id: string): Promise<TriageHistory[]> {
    await this.getRaw(id);
    return this.prisma.triageHistory.findMany({
      where: { victimId: id },
      orderBy: { createdAt: 'desc' },
    });
  }
  async countByPriority(): Promise<Record<Priority, number>> {
    const grouped = await this.prisma.victim.groupBy({
      by: ['currentPriority'],
      where: { status: VictimStatus.ACTIVE },
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
