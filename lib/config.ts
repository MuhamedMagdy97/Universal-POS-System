import { z } from "zod";

/**
 * Server configuration, validated once on first use.
 *
 * Read lazily (not at import time) so `next build` can load route modules
 * without a database. Never log the returned object: it holds secrets.
 */
const configSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  DATABASE_URL: z
    .string()
    .min(1, "DATABASE_URL is required")
    .refine((value) => /^postgres(ql)?:\/\//.test(value), "DATABASE_URL must be a postgres:// URL"),
  AUTH_SECRET: z.string().min(32, "AUTH_SECRET must be at least 32 characters"),
  AUTH_URL: z.url().optional(),
});

export type AppConfig = z.infer<typeof configSchema>;

let cached: AppConfig | undefined;

export function getConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  if (env === process.env && cached) return cached;
  const result = configSchema.safeParse(env);
  if (!result.success) {
    // Report which keys are wrong, never their values.
    const problems = result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`);
    throw new Error(`Invalid server configuration:\n- ${problems.join("\n- ")}`);
  }
  if (env === process.env) cached = result.data;
  return result.data;
}
