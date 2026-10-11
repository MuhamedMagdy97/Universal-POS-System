import { e2eQuery } from "./db";

/**
 * Creates one product for this run, so specs that open stock (one time per item and branch)
 * never collide with an earlier run of the same spec. Returns the product id.
 */
export async function createRunProduct(orgId: string, sku: string, name: string): Promise<string> {
  const rows = await e2eQuery<{ id: string }>(
    `INSERT INTO "Product" ("id", "orgId", "sku", "name", "unitType", "priceMinor", "costMinor", "vatApplicable",
                            "vatCategory", "hasVariants", "isActive", "createdAt", "updatedAt")
     VALUES (gen_random_uuid(), $1, $2, $3, 'EACH', 1000, 500, true, 'STANDARD', false, true, now(), now())
     RETURNING "id"`,
    [orgId, sku, name],
  );
  const id = rows[0]?.id;
  if (!id) throw new Error(`could not create product ${sku}`);
  return id;
}
