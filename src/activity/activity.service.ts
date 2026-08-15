import { Injectable } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ActivityLog, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class ActivityService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  async append(
    type: string,
    message: string,
    refs?: Record<string, any>,
  ): Promise<ActivityLog> {
    const row = await this.prisma.activityLog.create({
      data: {
        type,
        message,
        refs: refs !== undefined ? (refs as Prisma.InputJsonValue) : undefined,
      },
    });
    this.eventEmitter.emit('activity.created', row);
    return row;
  }

  list(limit = 50, offset = 0): Promise<ActivityLog[]> {
    return this.prisma.activityLog.findMany({
      orderBy: { createdAt: 'desc' },
      take: limit,
      skip: offset,
    });
  }
}
