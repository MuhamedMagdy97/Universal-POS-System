"use client";

import { useRouter } from "next/navigation";
import { authClient } from "@/lib/auth/auth-client";

export function SignOutButton() {
  const router = useRouter();

  async function signOut() {
    await authClient.signOut();
    router.push("/login");
    router.refresh();
  }

  return (
    <button type="button" onClick={signOut} className="rounded-md px-3 py-1 text-sm underline-offset-4 hover:underline">
      Sign out
    </button>
  );
}
