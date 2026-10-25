-- Scale labels (docs/planning/ui-refresh/weighed-selling-spec.md W6, W12). Settings only: no backfill.
CREATE TYPE "ScaleValueKind" AS ENUM ('WEIGHT', 'PRICE');

ALTER TABLE "Organization" ADD COLUMN     "scaleItemDigits" INTEGER NOT NULL DEFAULT 5,
ADD COLUMN     "scaleLabelPrefixes" TEXT[] DEFAULT ARRAY['20', '21', '22', '23', '24', '25', '26', '27', '28', '29']::TEXT[],
ADD COLUMN     "scaleLabelsEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "scaleValueKind" "ScaleValueKind" NOT NULL DEFAULT 'WEIGHT';

ALTER TABLE "Organization" ADD CONSTRAINT "Organization_scaleItemDigits_range" CHECK ("scaleItemDigits" BETWEEN 4 AND 6);
