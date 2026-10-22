import { Priority, Victim, VictimStatus } from '@prisma/client';

/**
 * What leaves the backend for a victim row. The database row carries personal
 * data (nik) and bookkeeping columns (devicePriority, override*) that clients
 * must not receive in raw form, so every REST and Socket.IO path goes through
 * toVictimView(). NIK is full only when the caller asked for the detail view.
 */
export interface OperatorOverride {
  priority: Priority;
  reason: string;
  at: Date;
}

export type VictimView = Omit<
  Victim,
  | 'nik'
  | 'devicePriority'
  | 'overridePriority'
  | 'overrideReason'
  | 'overrideAt'
> & {
  /** Full NIK; present on the detail view only, absent from lists and events. */
  nik?: string | null;
  nikMasked: string | null;
  operatorOverride: OperatorOverride | null;
  deviceDiffersFromOperator: boolean;
};

/** "3578123456780001" -> "3578********0001". Anything else is fully hidden. */
export function maskNik(nik: string | null | undefined): string | null {
  if (nik == null || nik === '') return null;
  if (!/^\d{16}$/.test(nik)) return '*'.repeat(Math.min(nik.length, 16));
  return `${nik.slice(0, 4)}********${nik.slice(12)}`;
}

export function toVictimView(v: Victim, full = false): VictimView {
  const {
    nik,
    devicePriority,
    overridePriority,
    overrideReason,
    overrideAt,
    ...rest
  } = v;
  const operatorOverride: OperatorOverride | null =
    overridePriority && overrideAt
      ? { priority: overridePriority, reason: overrideReason ?? '', at: overrideAt }
      : null;
  return {
    ...rest,
    ...(full ? { nik } : {}),
    nikMasked: maskNik(nik),
    operatorOverride,
    deviceDiffersFromOperator:
      operatorOverride !== null &&
      devicePriority != null &&
      devicePriority !== operatorOverride.priority,
  };
}

/** Statuses that take a patient off the active list and the active KPIs. */
export const INACTIVE_STATUSES: VictimStatus[] = [
  VictimStatus.REFERRED,
  VictimStatus.DISCHARGED,
  VictimStatus.DECEASED,
];
