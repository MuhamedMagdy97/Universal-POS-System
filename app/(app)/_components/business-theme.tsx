import { Icon } from "@/app/_ui/icons";
import { currentProfile } from "../_lib/business";

/**
 * The shop's accent (business-profiles-spec BP4): streamed into the layout, it overrides `--accent` and
 * `--accent-soft` from app/globals.css for light and dark. Without a shop the default blue stays.
 */
export async function BusinessTheme() {
  const profile = await currentProfile();
  if (!profile) return null;
  const { light, dark, softLight, softDark } = profile.accent;
  const css =
    `:root{--accent:${light};--accent-soft:${softLight}}` +
    `@media (prefers-color-scheme: dark){:root{--accent:${dark};--accent-soft:${softDark}}}`;
  return <style>{css}</style>;
}

/** BP5: the profile's icon in the sidebar brand (store while it streams in or without a shop). */
export async function BrandIcon() {
  const profile = await currentProfile();
  return <Icon name={profile?.icon ?? "store"} className="size-6" />;
}
