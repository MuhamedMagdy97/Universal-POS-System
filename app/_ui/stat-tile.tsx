import Link from "next/link";

/** Dashboard number tile (DS9). Money and counts stay `dir="ltr"` so digits read the same in Arabic. */
export function StatTile({
  label,
  value,
  href,
  tone = "neutral",
}: {
  label: string;
  value: string;
  href?: string;
  tone?: "neutral" | "warning";
}) {
  const body = (
    <>
      <span className={`text-sm ${tone === "warning" ? "text-warning" : "text-muted"}`}>{label}</span>
      <span dir="ltr" className="text-start text-2xl font-semibold tabular-nums">
        {value}
      </span>
    </>
  );
  const className = `card flex flex-col gap-1 ${tone === "warning" ? "border-warning/40 bg-warning-soft" : ""}`;
  return href ? (
    <Link href={href} className={`${className} transition-colors hover:border-border-strong`}>
      {body}
    </Link>
  ) : (
    <div className={className}>{body}</div>
  );
}
