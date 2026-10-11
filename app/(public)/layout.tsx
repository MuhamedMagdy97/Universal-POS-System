import type { ReactNode } from "react";
import Link from "next/link";

export default function PublicLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col">
      <header className="flex items-center gap-4 border-b border-border px-4 py-3">
        <Link href="/welcome" className="font-semibold">
          Universal POS
        </Link>
      </header>
      <main className="mx-auto flex w-full max-w-xl flex-1 flex-col gap-6 px-4 py-10">{children}</main>
    </div>
  );
}
