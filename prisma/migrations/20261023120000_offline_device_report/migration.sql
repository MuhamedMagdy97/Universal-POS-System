-- Offline till slice 4 (offline-till-spec OF14): each device reports how many sales it still holds unsynced.
ALTER TABLE "RegisterDevice" ADD COLUMN "reportedQueued" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "reportedOldestAt" TIMESTAMP(3),
ADD COLUMN "reportedAt" TIMESTAMP(3);
