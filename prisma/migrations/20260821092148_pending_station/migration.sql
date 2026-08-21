-- CreateTable
CREATE TABLE "PendingStation" (
    "mac" TEXT NOT NULL,
    "announcedStationId" TEXT NOT NULL,
    "ip" TEXT,
    "firmware" TEXT,
    "nodeCount" INTEGER,
    "firstSeen" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeen" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PendingStation_pkey" PRIMARY KEY ("mac")
);
