import { BUSINESS_PRESETS } from "@/modules/presets";

export default function OnboardingPage() {
  return (
    <>
      <h1 className="text-2xl font-semibold">Set up your business</h1>
      <p className="text-muted">
        Pick the type of business. A type applies a preset (currency, VAT default, receipt template) on top of the same
        core. Organization creation is delivered in task T2; this page lists what each type includes today.
      </p>
      <ul className="flex flex-col gap-2">
        {BUSINESS_PRESETS.map((preset) => (
          <li
            key={preset.id}
            className="flex items-center justify-between gap-4 rounded-md border border-border px-4 py-3"
          >
            <span>
              {preset.label.en} <span className="text-muted">· {preset.label.ar}</span>
            </span>
            <span
              className={
                preset.status === "included"
                  ? "rounded-full bg-green-100 px-2 py-0.5 text-sm text-green-800"
                  : "rounded-full bg-gray-100 px-2 py-0.5 text-sm text-gray-700"
              }
            >
              {preset.status === "included" ? "Included" : "Coming soon"}
            </span>
          </li>
        ))}
      </ul>
    </>
  );
}
