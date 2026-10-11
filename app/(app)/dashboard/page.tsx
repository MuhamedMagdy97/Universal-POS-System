import { Suspense } from "react";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth/session";

export default function DashboardPage() {
  return (
    <section className="flex flex-col gap-2">
      <h1 className="text-2xl font-semibold">Dashboard</h1>
      <Suspense fallback={<p className="text-muted">Loading…</p>}>
        <Greeting />
      </Suspense>
      <p className="text-muted">Selling, catalog and stock screens arrive in the next phases.</p>
    </section>
  );
}

async function Greeting() {
  const session = await getSession(await headers());
  if (!session) redirect("/login");
  return <p>Signed in as {session.user.name}.</p>;
}
