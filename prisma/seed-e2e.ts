/**
 * E2E seed (catalog Q13). Run from the Playwright global setup against
 * E2E_DATABASE_URL only; never against the development or test database.
 *
 * Idempotent: every row has a stable key (fixed UUID, email, SKU or barcode)
 * and is upserted back to the values below, so re-running resets the seeded
 * catalog. Rows the specs create (unique per run) are left alone.
 *
 * Plain SQL through `pg` keeps the seed loadable by Playwright's TypeScript
 * loader; passwords are hashed with the app's own Argon2 settings and stored in
 * the account layout Better-Auth uses for email + password sign-in.
 *
 * All passwords here are throwaway test values for this local/CI database only.
 */
import { Client } from "pg";
import { hashPassword } from "../lib/auth/password";

type Role = "OWNER" | "ADMIN" | "MANAGER" | "CASHIER" | "REPORTING";
type OrgKey = "A" | "B";

/** Second branch of org A, for inventory transfers (T4.8). Org A's admin has access to both. */
export const E2E_SECOND_BRANCH_A = {
  id: "e2e0a000-0000-4000-8000-0000000000b2",
  name: "Second",
  code: "SECOND",
} as const;

export const E2E_ORGS = {
  A: {
    id: "e2e0a000-0000-4000-8000-000000000001",
    branchId: "e2e0a000-0000-4000-8000-0000000000b1",
    name: "E2E Org A (Egypt)",
    countryCode: "EG",
    currency: "EGP",
    vatRateBp: 1400,
  },
  B: {
    id: "e2e0b000-0000-4000-8000-000000000001",
    branchId: "e2e0b000-0000-4000-8000-0000000000b1",
    name: "E2E Org B (Saudi)",
    countryCode: "SA",
    currency: "SAR",
    vatRateBp: 1500,
  },
} as const;

export type E2EUserKey = "ownerA" | "adminA" | "managerA" | "cashierA" | "reportingA" | "adminB";

export const E2E_USERS: Record<E2EUserKey, { email: string; password: string; name: string; role: Role; org: OrgKey }> =
  {
    ownerA: {
      email: "owner@org-a.e2e.test",
      password: "e2e-Owner-pw-4f9a2c",
      name: "Olivia Owner",
      role: "OWNER",
      org: "A",
    },
    adminA: {
      email: "admin@org-a.e2e.test",
      password: "e2e-Admin-pw-8b31d7",
      name: "Adam Admin",
      role: "ADMIN",
      org: "A",
    },
    managerA: {
      email: "manager@org-a.e2e.test",
      password: "e2e-Manager-pw-2c7e55",
      name: "Mona Manager",
      role: "MANAGER",
      org: "A",
    },
    cashierA: {
      email: "cashier@org-a.e2e.test",
      password: "e2e-Cashier-pw-6d04b8",
      name: "Karim Cashier",
      role: "CASHIER",
      org: "A",
    },
    reportingA: {
      email: "reporting@org-a.e2e.test",
      password: "e2e-Reporting-pw-91fa3e",
      name: "Rana Reporting",
      role: "REPORTING",
      org: "A",
    },
    adminB: {
      email: "admin@org-b.e2e.test",
      password: "e2e-AdminB-pw-5e62c0",
      name: "Badr Admin",
      role: "ADMIN",
      org: "B",
    },
  };

/** Catalog rows the specs refer to by value. */
export const E2E_FIXTURES = {
  /** Org A, Arabic name, 12.50 EGP. */
  arabic: {
    sku: "E2E-AR-001",
    name: "Arabic Coffee",
    nameAr: "قهوة عربية",
    priceMinor: 1250,
    barcode: "6220000000011",
  },
  /** Same SKU and barcode exist in both orgs with different names (isolation). */
  shared: {
    sku: "E2E-SHARED-001",
    barcode: "6220000099999",
    nameA: "Shared Item Org A",
    nameB: "Shared Item Org B",
  },
  /** Only in Org A. */
  aOnly: { sku: "E2E-A-ONLY-001", name: "Org A Only Tea", barcode: "6220000000028" },
  /** Archived in Org A. */
  archived: { sku: "E2E-ARCH-001", name: "Discontinued Biscuits", barcode: "6220000000035" },
} as const;

const CATEGORY_IDS = {
  aBeverages: "e2e0a000-0000-4000-8000-0000000000c1",
  aHotDrinks: "e2e0a000-0000-4000-8000-0000000000c2",
  aGrocery: "e2e0a000-0000-4000-8000-0000000000c3",
  aGrains: "e2e0a000-0000-4000-8000-0000000000c4",
  bGeneral: "e2e0b000-0000-4000-8000-0000000000c1",
} as const;

type CategoryRow = {
  id: string;
  org: OrgKey;
  parentId: string | null;
  name: string;
  nameAr: string;
  sortOrder: number;
};

const CATEGORIES: CategoryRow[] = [
  { id: CATEGORY_IDS.aBeverages, org: "A", parentId: null, name: "Beverages", nameAr: "مشروبات", sortOrder: 0 },
  {
    id: CATEGORY_IDS.aHotDrinks,
    org: "A",
    parentId: CATEGORY_IDS.aBeverages,
    name: "Hot drinks",
    nameAr: "مشروبات ساخنة",
    sortOrder: 0,
  },
  { id: CATEGORY_IDS.aGrocery, org: "A", parentId: null, name: "Grocery", nameAr: "بقالة", sortOrder: 1 },
  {
    id: CATEGORY_IDS.aGrains,
    org: "A",
    parentId: CATEGORY_IDS.aGrocery,
    name: "Rice and grains",
    nameAr: "أرز وحبوب",
    sortOrder: 0,
  },
  { id: CATEGORY_IDS.bGeneral, org: "B", parentId: null, name: "General", nameAr: "عام", sortOrder: 0 },
];

type VariantRow = { sku: string; name: string; nameAr: string; priceMinor: number | null; barcode: string };
type ProductRow = {
  org: OrgKey;
  sku: string;
  name: string;
  nameAr: string | null;
  categoryId: string | null;
  priceMinor: number;
  costMinor: number;
  isActive?: boolean;
  barcodes?: string[];
  variants?: VariantRow[];
};

const ARABIC_STAPLES = ["أرز", "سكر", "شاي", "زيت", "عدس", "مكرونة", "جبن", "حليب", "تمر", "عسل"];
const ENGLISH_STAPLES = ["Rice", "Sugar", "Tea", "Oil", "Lentils", "Pasta", "Cheese", "Milk", "Dates", "Honey"];

function products(): ProductRow[] {
  const f = E2E_FIXTURES;
  const rows: ProductRow[] = [
    {
      org: "A",
      sku: f.arabic.sku,
      name: f.arabic.name,
      nameAr: f.arabic.nameAr,
      categoryId: CATEGORY_IDS.aHotDrinks,
      priceMinor: f.arabic.priceMinor,
      costMinor: 800,
      barcodes: [f.arabic.barcode],
    },
    {
      org: "A",
      sku: f.shared.sku,
      name: f.shared.nameA,
      nameAr: "منتج مشترك أ",
      categoryId: CATEGORY_IDS.aGrocery,
      priceMinor: 500,
      costMinor: 300,
      barcodes: [f.shared.barcode],
    },
    {
      org: "A",
      sku: f.aOnly.sku,
      name: f.aOnly.name,
      nameAr: "شاي المنظمة أ",
      categoryId: CATEGORY_IDS.aHotDrinks,
      priceMinor: 2000,
      costMinor: 1200,
      barcodes: [f.aOnly.barcode],
    },
    {
      org: "A",
      sku: f.archived.sku,
      name: f.archived.name,
      nameAr: "بسكويت متوقف",
      categoryId: CATEGORY_IDS.aGrocery,
      priceMinor: 750,
      costMinor: 400,
      isActive: false,
      barcodes: [f.archived.barcode],
    },
    {
      org: "A",
      sku: "E2E-TSHIRT",
      name: "Cotton T-shirt",
      nameAr: "تيشيرت قطن",
      categoryId: null,
      priceMinor: 15000,
      costMinor: 9000,
      variants: [
        { sku: "E2E-TSHIRT-S", name: "Small", nameAr: "صغير", priceMinor: null, barcode: "6220000001001" },
        { sku: "E2E-TSHIRT-L", name: "Large", nameAr: "كبير", priceMinor: 16500, barcode: "6220000001002" },
      ],
    },
    {
      org: "A",
      sku: "E2E-JUICE",
      name: "Fresh Juice",
      nameAr: "عصير طازج",
      categoryId: CATEGORY_IDS.aBeverages,
      priceMinor: 3000,
      costMinor: 1500,
      variants: [
        { sku: "E2E-JUICE-ORANGE", name: "Orange", nameAr: "برتقال", priceMinor: null, barcode: "6220000001011" },
        { sku: "E2E-JUICE-MANGO", name: "Mango", nameAr: "مانجو", priceMinor: 3500, barcode: "6220000001012" },
      ],
    },
  ];

  // Bulk Org A catalog: 54 simple products, Arabic names, two-level categories.
  for (let i = 1; i <= 54; i++) {
    const n = String(i).padStart(3, "0");
    const staple = (i - 1) % ARABIC_STAPLES.length;
    rows.push({
      org: "A",
      sku: `E2E-P-${n}`,
      name: `${ENGLISH_STAPLES[staple]} pack ${n}`,
      nameAr: `${ARABIC_STAPLES[staple]} عبوة ${n}`,
      categoryId: i % 3 === 0 ? CATEGORY_IDS.aGrains : i % 3 === 1 ? CATEGORY_IDS.aGrocery : null,
      priceMinor: 100 * i + 50,
      costMinor: 80 * i,
      barcodes: [`62210000${n}00`],
    });
  }

  // Org B (SAR): the shared SKU/barcode with different data, plus a few of its own.
  rows.push({
    org: "B",
    sku: f.shared.sku,
    name: f.shared.nameB,
    nameAr: "منتج مشترك ب",
    categoryId: CATEGORY_IDS.bGeneral,
    priceMinor: 900,
    costMinor: 500,
    barcodes: [f.shared.barcode],
  });
  for (let i = 1; i <= 5; i++) {
    const n = String(i).padStart(3, "0");
    rows.push({
      org: "B",
      sku: `E2E-B-${n}`,
      name: `Saudi item ${n}`,
      nameAr: `صنف سعودي ${n}`,
      categoryId: CATEGORY_IDS.bGeneral,
      priceMinor: 1000 + i * 100,
      costMinor: 600,
      barcodes: [`62820000${n}00`],
    });
  }
  return rows;
}

function returnedId(rows: { id: string }[]): string {
  const id = rows[0]?.id;
  if (!id) throw new Error("Upsert returned no row");
  return id;
}

async function upsertBarcode(
  client: Client,
  orgId: string,
  code: string,
  productId: string,
  variantId: string | null,
  isPrimary: boolean,
) {
  // Move any stale primary of this item out of the way first (one primary per item).
  if (isPrimary) {
    await client.query(
      `UPDATE "Barcode" SET "isPrimary" = false, "updatedAt" = now()
        WHERE "orgId" = $1 AND "productId" = $2 AND "variantId" IS NOT DISTINCT FROM $3 AND "code" <> $4 AND "isPrimary"`,
      [orgId, productId, variantId, code],
    );
  }
  await client.query(
    `INSERT INTO "Barcode" ("id", "orgId", "code", "productId", "variantId", "isPrimary", "createdAt", "updatedAt")
     VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, now(), now())
     ON CONFLICT ("orgId", "code") DO UPDATE
       SET "productId" = EXCLUDED."productId", "variantId" = EXCLUDED."variantId",
           "isPrimary" = EXCLUDED."isPrimary", "updatedAt" = now()`,
    [orgId, code, productId, variantId, isPrimary],
  );
}

export async function seedE2E(connectionString: string): Promise<void> {
  const client = new Client({ connectionString });
  await client.connect();
  try {
    await client.query("BEGIN");

    for (const org of Object.values(E2E_ORGS)) {
      await client.query(
        `INSERT INTO "Organization" ("id", "name", "businessType", "countryCode", "currency", "vatRateBp", "createdAt", "updatedAt")
         VALUES ($1, $2, 'RETAIL', $3, $4, $5, now(), now())
         ON CONFLICT ("id") DO UPDATE SET "name" = EXCLUDED."name", "countryCode" = EXCLUDED."countryCode",
           "currency" = EXCLUDED."currency", "vatRateBp" = EXCLUDED."vatRateBp", "updatedAt" = now()`,
        [org.id, org.name, org.countryCode, org.currency, org.vatRateBp],
      );
      await client.query(
        `INSERT INTO "Branch" ("id", "orgId", "name", "code", "createdAt", "updatedAt")
         VALUES ($1, $2, 'Main', 'MAIN', now(), now())
         ON CONFLICT ("id") DO UPDATE SET "isActive" = true, "updatedAt" = now()`,
        [org.branchId, org.id],
      );
    }
    await client.query(
      `INSERT INTO "Branch" ("id", "orgId", "name", "code", "createdAt", "updatedAt")
       VALUES ($1, $2, $3, $4, now(), now())
       ON CONFLICT ("id") DO UPDATE SET "isActive" = true, "updatedAt" = now()`,
      [E2E_SECOND_BRANCH_A.id, E2E_ORGS.A.id, E2E_SECOND_BRANCH_A.name, E2E_SECOND_BRANCH_A.code],
    );

    for (const user of Object.values(E2E_USERS)) {
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO "User" ("id", "name", "email", "emailVerified", "createdAt", "updatedAt")
         VALUES (gen_random_uuid(), $1, $2, true, now(), now())
         ON CONFLICT ("email") DO UPDATE SET "name" = EXCLUDED."name", "updatedAt" = now()
         RETURNING "id"`,
        [user.name, user.email],
      );
      const userId = returnedId(rows);
      // Better-Auth email + password layout: providerId "credential", accountId = user id.
      await client.query(`DELETE FROM "Account" WHERE "userId" = $1 AND "providerId" = 'credential'`, [userId]);
      await client.query(
        `INSERT INTO "Account" ("id", "accountId", "providerId", "userId", "password", "createdAt", "updatedAt")
         VALUES (gen_random_uuid(), $1, 'credential', $2, $3, now(), now())`,
        [userId, userId, await hashPassword(user.password)],
      );
      await client.query(
        `INSERT INTO "Membership" ("id", "orgId", "userId", "role", "allBranches", "isActive", "createdAt", "updatedAt")
         VALUES (gen_random_uuid(), $1, $2, $3, true, true, now(), now())
         ON CONFLICT ("orgId", "userId") DO UPDATE
           SET "role" = EXCLUDED."role", "allBranches" = true, "isActive" = true, "updatedAt" = now()`,
        [E2E_ORGS[user.org].id, userId, user.role],
      );
    }

    for (const c of CATEGORIES) {
      await client.query(
        `INSERT INTO "Category" ("id", "orgId", "parentId", "name", "nameAr", "isActive", "sortOrder", "createdAt", "updatedAt")
         VALUES ($1, $2, $3, $4, $5, true, $6, now(), now())
         ON CONFLICT ("id") DO UPDATE SET "parentId" = EXCLUDED."parentId", "name" = EXCLUDED."name",
           "nameAr" = EXCLUDED."nameAr", "isActive" = true, "sortOrder" = EXCLUDED."sortOrder", "updatedAt" = now()`,
        [c.id, E2E_ORGS[c.org].id, c.parentId, c.name, c.nameAr, c.sortOrder],
      );
    }

    for (const p of products()) {
      const orgId = E2E_ORGS[p.org].id;
      const hasVariants = Boolean(p.variants?.length);
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO "Product" ("id", "orgId", "categoryId", "sku", "name", "nameAr", "unitType", "priceMinor", "costMinor",
                                "vatApplicable", "vatCategory", "hasVariants", "isActive", "createdAt", "updatedAt")
         VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, 'EACH', $6, $7, true, 'STANDARD', $8, $9, now(), now())
         ON CONFLICT ("orgId", "sku") DO UPDATE SET "categoryId" = EXCLUDED."categoryId", "name" = EXCLUDED."name",
           "nameAr" = EXCLUDED."nameAr", "unitType" = 'EACH', "priceMinor" = EXCLUDED."priceMinor",
           "costMinor" = EXCLUDED."costMinor", "vatApplicable" = true, "vatCategory" = 'STANDARD',
           "hasVariants" = EXCLUDED."hasVariants", "isActive" = EXCLUDED."isActive", "updatedAt" = now()
         RETURNING "id"`,
        [orgId, p.categoryId, p.sku, p.name, p.nameAr, p.priceMinor, p.costMinor, hasVariants, p.isActive ?? true],
      );
      const productId = returnedId(rows);

      for (const [index, code] of (p.barcodes ?? []).entries()) {
        await upsertBarcode(client, orgId, code, productId, null, index === 0);
      }

      for (const [index, v] of (p.variants ?? []).entries()) {
        const { rows: variantRows } = await client.query<{ id: string }>(
          `INSERT INTO "ProductVariant" ("id", "orgId", "productId", "sku", "name", "nameAr", "priceMinor", "costMinor",
                                         "isActive", "sortOrder", "createdAt", "updatedAt")
           VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, NULL, true, $7, now(), now())
           ON CONFLICT ("orgId", "sku") DO UPDATE SET "name" = EXCLUDED."name", "nameAr" = EXCLUDED."nameAr",
             "priceMinor" = EXCLUDED."priceMinor", "costMinor" = NULL, "isActive" = true,
             "sortOrder" = EXCLUDED."sortOrder", "updatedAt" = now()
           RETURNING "id"`,
          [orgId, productId, v.sku, v.name, v.nameAr, v.priceMinor, index],
        );
        await upsertBarcode(client, orgId, v.barcode, productId, returnedId(variantRows), true);
      }
    }

    // Fresh login rate-limit counters for every run.
    await client.query(`DELETE FROM "RateLimit"`);

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    await client.end();
  }
}
