import { toNextJsHandler } from "better-auth/next-js";
import { getAuth } from "@/lib/auth/auth";

// Better-Auth endpoints: /api/auth/sign-in/email, /sign-out, /get-session, /revoke-session, ...
export async function GET(request: Request) {
  return toNextJsHandler(getAuth()).GET(request);
}

export async function POST(request: Request) {
  return toNextJsHandler(getAuth()).POST(request);
}
