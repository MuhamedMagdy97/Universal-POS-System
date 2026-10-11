"use client";

import { CatalogError } from "./_components/catalog-error";

/** Catches unexpected failures on every catalog page (e.g. database unavailable) and offers Retry. */
export default function CatalogErrorBoundary({ retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return <CatalogError retry={retry} />;
}
