import { z } from "zod";

/**
 * Customer input schemas (customers-spec CU1). Pure: client components import this file. The phone
 * is checked and normalised to E.164 in the service, which knows the shop's country.
 */

export const Uuid = z.uuid();

const OptionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullish()
    .transform((value) => (value === undefined || value === null || value === "" ? null : value));

export const CustomerInput = z
  .object({
    name: z.string().trim().min(1).max(120),
    phone: z.string().trim().min(1).max(40),
    email: z
      .union([z.literal(""), z.email().max(254)])
      .nullish()
      .transform((value) => (value ? value : null)),
    taxNumber: OptionalText(40),
    note: OptionalText(500),
  })
  .strict();
export type CustomerInput = z.infer<typeof CustomerInput>;

/** Any field to change, or `isActive` to archive (false) or restore (true). */
export const CustomerPatch = CustomerInput.partial().extend({ isActive: z.boolean().optional() }).strict();
export type CustomerPatch = z.infer<typeof CustomerPatch>;

export const CustomerQuery = z
  .object({
    q: z.string().trim().max(120).optional(),
    includeArchived: z
      .enum(["true", "false"])
      .optional()
      .transform((value) => value === "true"),
    limit: z.coerce.number().int().min(1).max(200).optional(),
  })
  .strict();
export type CustomerQuery = z.infer<typeof CustomerQuery>;
