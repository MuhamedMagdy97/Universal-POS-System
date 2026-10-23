import type { ReactNode } from "react";
import Link from "next/link";
import { Icon } from "@/app/_ui/icons";
import { LocaleToggle } from "../(app)/_components/locale-toggle";

/** Signed-out pages (design-system-spec DS12): brand mark, language toggle, a centred column. */
export default function PublicLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col">
      <header className="flex min-h-14 items-center gap-4 px-4">
        <Link href="/welcome" className="flex items-center gap-2 font-semibold">
          <Icon name="store" className="size-6 text-accent" />
          Universal POS
        </Link>
        <div className="ms-auto">
          <LocaleToggle />
        </div>
      </header>
      <main className="mx-auto flex w-full max-w-md flex-1 flex-col justify-center gap-5 px-4 pt-6 pb-16">
        {children}
      </main>
    </div>
  );
}
