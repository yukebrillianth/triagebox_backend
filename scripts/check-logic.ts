/**
 * Regression checks for the pure logic added with the identity / override /
 * timing work. No database, no broker: `npm run check:logic`.
 */
import * as assert from 'node:assert/strict';
import { Priority, Victim, VictimStatus } from '@prisma/client';
import { linkWindow } from '../src/common/link-stats';
import { timingProblems } from '../src/common/timing';
import { maskNik, toVictimView } from '../src/victims/victim-view';

const now = new Date('2026-10-22T10:00:00Z');
function victim(over: Partial<Victim> = {}): Victim {
  return {
    id: 'v1', rfid: 'TB-04A2B3', name: null, age: null, gender: null, notes: null,
    nik: null, address: null, familyContactName: null, familyContactPhone: null,
    chiefComplaint: null, status: VictimStatus.ACTIVE, referredAt: null,
    referralDestination: null, statusChangedBy: null, bpMeasuredAt: null,
    hrSource: null, devicePriority: Priority.GREEN, overridePriority: null,
    overrideReason: null, overrideAt: null, currentPriority: Priority.GREEN,
    confidence: null, reasons: null, currentNodeId: null, firstSeen: now,
    lastUpdate: now, createdAt: now, updatedAt: now, ...over,
  } as Victim;
}

// --- NIK masking: first 4 and last 4 only; malformed values are fully hidden.
assert.equal(maskNik('3578123456780001'), '3578********0001');
assert.equal(maskNik(null), null);
assert.equal(maskNik(''), null);
assert.equal(maskNik('12345'), '*****');

// --- The list view never carries the NIK; the detail view does.
const withNik = victim({ nik: '3578123456780001' });
const listView = toVictimView(withNik, false) as unknown as Record<string, unknown>;
assert.ok(!('nik' in listView), 'list view must not carry nik');
assert.equal(listView.nikMasked, '3578********0001');
assert.equal(JSON.stringify(listView).includes('3578123456780001'), false);
assert.equal(toVictimView(withNik, true).nik, '3578123456780001');
for (const k of ['devicePriority', 'overridePriority', 'overrideReason', 'overrideAt']) {
  assert.ok(!(k in listView), `${k} is internal bookkeeping`);
}

// --- Override: standing override shows, and a differing device category flags.
const noOverride = toVictimView(victim(), false);
assert.equal(noOverride.operatorOverride, null);
assert.equal(noOverride.deviceDiffersFromOperator, false);
const overridden = victim({
  currentPriority: Priority.BLACK, overridePriority: Priority.BLACK,
  overrideReason: 'tidak ada nadi', overrideAt: now, devicePriority: Priority.RED,
});
const ov = toVictimView(overridden, false);
assert.equal(ov.operatorOverride?.priority, Priority.BLACK);
assert.equal(ov.operatorOverride?.reason, 'tidak ada nadi');
assert.equal(ov.deviceDiffersFromOperator, true);
assert.equal(
  toVictimView({ ...overridden, devicePriority: Priority.BLACK } as Victim, false)
    .deviceDiffersFromOperator,
  false,
);

// --- Packet loss from the schedule: 15 s cycle over 150 s = 11 polls expected.
assert.deepEqual(linkWindow(0, 150_000, 15, 11), { expected: 11, received: 11, lossPct: 0 });
assert.equal(linkWindow(0, 150_000, 15, 10).lossPct, 9.1);
assert.equal(linkWindow(0, 150_000, 15, 99).lossPct, 0, 'never negative');
assert.equal(linkWindow(0, 150_000, 0, 5).lossPct, null);
assert.equal(linkWindow(10, 5, 15, 0).lossPct, null);

// --- Timing rules: offline threshold must outlast 3 poll cycles.
assert.deepEqual(timingProblems(15, 45), []);
assert.equal(timingProblems(15, 44).length, 1);
assert.equal(timingProblems(30, 45).length, 1);
assert.equal(timingProblems(0, 45).length, 1);
assert.equal(timingProblems(NaN, 45).length, 1);

console.log('backend logic checks: all passed');
