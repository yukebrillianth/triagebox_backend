-- CreateEnum
CREATE TYPE "VictimStatus" AS ENUM ('ACTIVE', 'REFERRED', 'DISCHARGED', 'DECEASED');

-- CreateEnum
CREATE TYPE "TriageSource" AS ENUM ('DEVICE', 'OPERATOR');

-- AlterTable
ALTER TABLE "Station" ADD COLUMN     "locationLabel" TEXT,
ADD COLUMN     "nodeCapacity" INTEGER NOT NULL DEFAULT 20,
ADD COLUMN     "pollPeriodSec" INTEGER,
ADD COLUMN     "postName" TEXT;

-- AlterTable
ALTER TABLE "TriageHistory" ADD COLUMN     "reason" TEXT,
ADD COLUMN     "source" "TriageSource" NOT NULL DEFAULT 'DEVICE';

-- AlterTable
ALTER TABLE "Victim" ADD COLUMN     "address" TEXT,
ADD COLUMN     "bpMeasuredAt" TIMESTAMP(3),
ADD COLUMN     "chiefComplaint" TEXT,
ADD COLUMN     "devicePriority" "Priority",
ADD COLUMN     "familyContactName" TEXT,
ADD COLUMN     "familyContactPhone" TEXT,
ADD COLUMN     "hrSource" TEXT,
ADD COLUMN     "nik" TEXT,
ADD COLUMN     "overrideAt" TIMESTAMP(3),
ADD COLUMN     "overridePriority" "Priority",
ADD COLUMN     "overrideReason" TEXT,
ADD COLUMN     "referralDestination" TEXT,
ADD COLUMN     "referredAt" TIMESTAMP(3),
ADD COLUMN     "status" "VictimStatus" NOT NULL DEFAULT 'ACTIVE',
ADD COLUMN     "statusChangedBy" TEXT;

-- CreateTable
CREATE TABLE "LinkSample" (
    "id" TEXT NOT NULL,
    "nodeId" TEXT NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "rssi" INTEGER,
    "snr" DOUBLE PRECISION,
    "packetCounter" INTEGER,

    CONSTRAINT "LinkSample_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "LinkSample_nodeId_receivedAt_idx" ON "LinkSample"("nodeId", "receivedAt");

-- AddForeignKey
ALTER TABLE "LinkSample" ADD CONSTRAINT "LinkSample_nodeId_fkey" FOREIGN KEY ("nodeId") REFERENCES "Node"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
