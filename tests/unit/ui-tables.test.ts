import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * UI refresh A (design-system-spec DS7, DS10): every on-screen table uses the `table` class, so
 * cells get padding and dividers. Print layouts use bare `<table>` or `receipt-rule`.
 */
function tsxFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return tsxFiles(path);
    return path.endsWith(".tsx") ? [path] : [];
  });
}

describe("screen tables", () => {
  it("use the table class or are print tables", () => {
    const offenders: string[] = [];
    for (const file of tsxFiles(join(process.cwd(), "app"))) {
      const source = readFileSync(file, "utf8");
      for (const match of source.matchAll(/<table\b[^>]*>/g)) {
        const className = /className="([^"]*)"/.exec(match[0])?.[1];
        if (className !== undefined && className !== "table" && className !== "receipt-rule") {
          offenders.push(`${file}: ${match[0]}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
