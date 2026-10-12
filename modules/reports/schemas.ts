import { z } from "zod";

/** Query-string schemas for reports and the audit trail. Strict: unknown keys are a 422. */

export const REPORT_NAMES = [
  "sales-summary",
  "payments",
  "products",
  "categories",
  "cashiers",
  "shifts",
  "refunds-voids",
  "vat",
] as const;
export type ReportName = (typeof REPORT_NAMES)[number];

export function isReportName(value: string): value is ReportName {
  return (REPORT_NAMES as readonly string[]).includes(value);
}

const Uuid = z.uuid();
const LocalDate = z.string().max(20);
const Format = z.enum(["json", "csv"]);

export const ReportQuery = z
  .object({
    branchId: Uuid.optional(),
    from: LocalDate.optional(),
    to: LocalDate.optional(),
    format: Format.optional(),
    locale: z.enum(["en", "ar"]).optional(),
  })
  .strict();
export type ReportQuery = z.infer<typeof ReportQuery>;

/** `*.permission.denied` matches every denied-attempt action. */
export const DENIED_ACTIONS = "*.permission.denied";

export const AuditQuery = z
  .object({
    from: LocalDate.optional(),
    to: LocalDate.optional(),
    actor: Uuid.optional(),
    action: z
      .string()
      .regex(/^(\*|[a-z][a-z0-9_]*)(\.[a-z][a-z0-9_]*)+$/)
      .optional(),
    entityType: z.string().min(1).max(64).optional(),
    entityId: z.string().min(1).max(128).optional(),
    cursor: z.string().max(200).optional(),
    format: Format.optional(),
    locale: z.enum(["en", "ar"]).optional(),
  })
  .strict()
  .refine((q) => q.entityId === undefined || q.entityType !== undefined, {
    message: "entityId needs entityType",
    path: ["entityId"],
  })
  .refine((q) => q.action === undefined || !q.action.startsWith("*") || q.action === DENIED_ACTIONS, {
    message: `The only wildcard action is ${DENIED_ACTIONS}`,
    path: ["action"],
  });
export type AuditQuery = z.infer<typeof AuditQuery>;
