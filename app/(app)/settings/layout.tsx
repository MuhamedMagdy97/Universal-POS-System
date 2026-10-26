import { Suspense, type ReactNode } from "react";
import { currentProfile } from "../_lib/business";
import { SettingsTabs } from "./_components/settings-tabs";

/**
 * Settings menu (onboarding O13): Shop, Receipt, Staff, Branches, Tables (cafés, restaurant-cafe-spec R3), Inventory
 * system (Phase 13), Offline. Each page checks its own permission.
 */
export default function SettingsLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-col gap-4">
      <Suspense fallback={<SettingsTabs />}>
        <ProfileTabs />
      </Suspense>
      {children}
    </div>
  );
}

async function ProfileTabs() {
  const profile = await currentProfile();
  return <SettingsTabs tables={profile?.tickets ?? false} team={profile?.appointments ?? false} />;
}
