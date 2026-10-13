-- T10 H6: business API rate limit, one row per (org, user, bucket), fixed 60 s window.
-- Hand-written: `migrate dev` also proposes dropping "POItem_one_line_per_item" (an
-- expression-style index Prisma cannot model); that index must stay.
CREATE TABLE "ApiRateLimit" (
    "key" TEXT NOT NULL,
    "windowStart" TIMESTAMPTZ(3) NOT NULL,
    "count" INTEGER NOT NULL,

    CONSTRAINT "ApiRateLimit_pkey" PRIMARY KEY ("key")
);
