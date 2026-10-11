import Link from "next/link";

export default function WelcomePage() {
  return (
    <>
      <h1 className="text-2xl font-semibold">Welcome to Universal POS</h1>
      <p className="text-muted">Point of sale, catalog and inventory for retail shops in Egypt and Saudi Arabia.</p>
      <div className="flex gap-3">
        <Link href="/login" className="rounded-md bg-foreground px-4 py-2 text-background">
          Sign in
        </Link>
        <Link href="/onboarding" className="rounded-md border border-border px-4 py-2">
          Set up a new business
        </Link>
      </div>
    </>
  );
}
