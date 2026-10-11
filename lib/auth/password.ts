import { hash, verify } from "@node-rs/argon2";

// Argon2id (library default) with OWASP-recommended minimum parameters.
const ARGON2_OPTIONS = { memoryCost: 19_456, timeCost: 2, parallelism: 1 } as const;

export function hashPassword(password: string): Promise<string> {
  return hash(password, ARGON2_OPTIONS);
}

export async function verifyPassword({ hash: digest, password }: { hash: string; password: string }): Promise<boolean> {
  try {
    return await verify(digest, password);
  } catch {
    // Malformed digest: treat as a failed login, never as a crash.
    return false;
  }
}
