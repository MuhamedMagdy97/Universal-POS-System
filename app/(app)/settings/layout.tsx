import type { ReactNode } from "react";
import { SettingsTabs } from "./_components/settings-tabs";

/** Settings menu (onboarding O13): Receipt, Staff, Branches. Each page checks its own permission. */
export default function SettingsLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-col gap-4">
      <SettingsTabs />
      {children}
    </div>
  );
}
