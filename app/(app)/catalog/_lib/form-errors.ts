/**
 * Pure mapping from the `{ code, message, details }` error envelope to form
 * state (field errors + summary). Shared by the product and category forms and
 * unit-tested in tests/unit/catalog-form-errors.test.ts. Client-safe.
 */
import type { ErrorBody } from "@/lib/errors";
import type { MessageKey, translator } from "@/lib/i18n";

/** Server Action result: `{ ok, data } | { ok: false, error }` (catalog-api-and-rules.md §1.4). */
export type ActionResult<T> = { ok: true; data: T } | { ok: false; error: ErrorBody };

/** "barcodes[0]" → "barcodes.0"; "variants[1].sku" → "variants.1.sku". */
export function normalizeFieldPath(field: string): string {
  return field.replace(/\[(\d+)\]/g, ".$1").replace(/^\./, "");
}

type ZodIssueDetail = { path: string; code: string; message: string };

function isIssueList(details: unknown): details is ZodIssueDetail[] {
  return (
    Array.isArray(details) &&
    details.every((d) => typeof d === "object" && d !== null && typeof (d as { path?: unknown }).path === "string")
  );
}

function detailsRecord(details: unknown): Record<string, unknown> | null {
  return typeof details === "object" && details !== null && !Array.isArray(details)
    ? (details as Record<string, unknown>)
    : null;
}

function joinPath(prefix: string, path: string): string {
  if (!prefix) return path;
  return path ? `${prefix}.${path}` : prefix;
}

/**
 * Re-roots the field paths of an error raised by one step of a multi-step save
 * (e.g. creating variant #2) so they point at the right form field.
 * `fieldOverride` replaces the service's own field name (e.g. "code" → "barcodes.3").
 */
export function scopeError(body: ErrorBody, prefix: string, fieldOverride?: string): ErrorBody {
  if (isIssueList(body.details)) {
    return {
      ...body,
      details: body.details.map((issue) => ({
        ...issue,
        path: fieldOverride ?? joinPath(prefix, normalizeFieldPath(issue.path)),
      })),
    };
  }
  const record = detailsRecord(body.details);
  if (record && (typeof record.field === "string" || fieldOverride)) {
    const field = fieldOverride ?? joinPath(prefix, normalizeFieldPath(String(record.field)));
    return { ...body, details: { ...record, field } };
  }
  return body;
}

export type Translate = ReturnType<typeof translator>;

export type FormErrors = {
  /** Field path (e.g. "sku", "barcodes.1", "variants.0.priceMinor") → message. */
  fields: Record<string, string>;
  /** Text for the `role="alert"` summary; null when there is nothing to show. */
  summary: string | null;
  /** 409 STALE_WRITE (or an archive race): the user must reload. */
  stale: boolean;
};

export const NO_ERRORS: FormErrors = { fields: {}, summary: null, stale: false };

function lastSegment(path: string): string {
  const parts = path.split(".");
  for (let i = parts.length - 1; i >= 0; i -= 1) {
    const part = parts[i];
    if (part !== undefined && !/^\d+$/.test(part)) return part;
  }
  return path;
}

/** Message for one zod issue, chosen by issue code and the field it is on. */
function issueMessage(issue: ZodIssueDetail, tr: Translate): string {
  const field = lastSegment(issue.path);
  if (issue.message === "Duplicate barcode in request") return tr("catalog.conflict.barcodeDuplicateInForm");
  if (issue.message === "Duplicate SKU in request") return tr("catalog.conflict.skuDuplicateInForm");
  if (issue.message === "UNIT_NOT_SUPPORTED") return tr("catalog.form.error.unitNotSupported");
  switch (issue.code) {
    case "too_small":
      return tr("catalog.form.error.required");
    case "too_big":
      return field === "priceMinor" || field === "costMinor"
        ? tr("catalog.form.error.invalidAmount")
        : tr("catalog.form.error.tooLong");
    case "invalid_format":
      if (field === "sku") return tr("catalog.form.error.skuInvalid");
      if (field === "barcodes" || field === "code") return tr("catalog.form.error.barcodeInvalid");
      return tr("catalog.form.error.invalid");
    default:
      if (field === "priceMinor" || field === "costMinor") return tr("catalog.form.error.invalidAmount");
      return tr("catalog.form.error.invalid");
  }
}

const VALIDATION_REASON_KEYS = {
  CATEGORY_INACTIVE: "catalog.form.error.categoryInactive",
  CATEGORY_TOO_DEEP: "catalog.conflict.categoryTooDeep",
  CATEGORY_CYCLE: "catalog.conflict.categoryCycle",
  UNIT_NOT_SUPPORTED: "catalog.form.error.unitNotSupported",
  UNIT_IMMUTABLE: "catalog.form.unitHint",
  VARIANT_REQUIRED: "catalog.form.error.variantRequired",
} as const satisfies Record<string, MessageKey>;

function validationReasonKey(reason: string | null) {
  return reason && Object.hasOwn(VALIDATION_REASON_KEYS, reason)
    ? VALIDATION_REASON_KEYS[reason as keyof typeof VALIDATION_REASON_KEYS]
    : null;
}

const STALE_REASONS = new Set(["STALE_WRITE", "ALREADY_ARCHIVED", "NOT_ARCHIVED", "PRIMARY_BARCODE_TAKEN"]);

/**
 * Maps an action error to form state. `existingName` (added by the Server
 * Action from the caller's own org) names the product that holds a SKU/barcode.
 */
export function mapErrorBody(body: ErrorBody, tr: Translate): FormErrors {
  const fields: Record<string, string> = {};

  if (body.code === "VALIDATION_FAILED" && isIssueList(body.details)) {
    for (const issue of body.details) {
      const path = normalizeFieldPath(issue.path);
      fields[path] ??= issueMessage(issue, tr);
    }
    return { fields, summary: tr("catalog.form.errorSummary"), stale: false };
  }

  const details = detailsRecord(body.details);
  const reason = typeof details?.reason === "string" ? details.reason : null;
  const field = typeof details?.field === "string" ? normalizeFieldPath(details.field) : null;
  const holder =
    typeof details?.existingName === "string" && details.existingName
      ? details.existingName
      : tr("catalog.conflict.anotherProduct");

  let message: string | null = null;
  if (body.code === "CONFLICT") {
    if (reason && STALE_REASONS.has(reason)) {
      return { fields, summary: tr("catalog.conflict.staleWrite"), stale: true };
    }
    if (reason === "SKU_TAKEN") message = tr("catalog.conflict.skuTaken", { product: holder });
    else if (reason === "BARCODE_TAKEN") message = tr("catalog.conflict.barcodeTaken", { product: holder });
    else if (reason === "NAME_TAKEN") message = tr("catalog.conflict.nameTaken");
    else if (reason === "CATEGORY_HAS_ACTIVE_CHILDREN") message = tr("catalog.conflict.categoryHasChildren");
  } else if (body.code === "VALIDATION_FAILED") {
    const key = validationReasonKey(reason);
    message = key ? tr(key) : tr("catalog.form.error.invalid");
  } else if (body.code === "FORBIDDEN" || body.code === "UNAUTHENTICATED") {
    return { fields, summary: tr("catalog.form.error.forbidden"), stale: false };
  } else if (body.code === "NOT_FOUND") {
    return { fields, summary: tr("catalog.form.error.notFound"), stale: false };
  }

  if (message === null) return { fields, summary: tr("catalog.form.error.generic"), stale: false };
  if (field) {
    fields[field] = message;
    return { fields, summary: tr("catalog.form.errorSummary"), stale: false };
  }
  return { fields, summary: message, stale: false };
}
