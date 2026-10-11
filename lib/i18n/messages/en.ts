/**
 * English strings: the source of truth for message keys. Every other locale
 * must provide exactly these keys (enforced by the `Messages` type and a unit test).
 * Placeholders use `{name}` and are filled by `t()`.
 */
export const en = {
  // Navigation
  "catalog.nav": "Catalog",
  "catalog.nav.products": "Products",
  "catalog.nav.categories": "Categories",

  // Product list
  "catalog.products.title": "Products",
  "catalog.products.add": "Add product",
  "catalog.products.searchPlaceholder": "Search name, SKU or scan a barcode",
  "catalog.products.column.name": "Name",
  "catalog.products.column.sku": "SKU",
  "catalog.products.column.barcode": "Barcode",
  "catalog.products.column.category": "Category",
  "catalog.products.column.price": "Price",
  "catalog.products.column.vat": "VAT",
  "catalog.products.column.status": "Status",
  "catalog.products.filter.category": "Category",
  "catalog.products.filter.status": "Status",
  "catalog.products.filter.vat": "VAT applicable",
  "catalog.products.filter.all": "All",
  "catalog.products.loadMore": "Load more",

  // Status and flags
  "catalog.status.active": "Active",
  "catalog.status.archived": "Archived",
  "catalog.vat.yes": "Yes",
  "catalog.vat.no": "No",
  "catalog.category.none": "Uncategorised",

  // States
  "catalog.state.loading": "Loading products…",
  "catalog.state.empty.title": "No products yet",
  "catalog.state.empty.body": "Add your first product to start selling.",
  "catalog.state.noResults": "No match for “{q}”",
  "catalog.state.clearFilters": "Clear filters",
  "catalog.state.error": "Something went wrong while loading the catalog.",
  "catalog.state.retry": "Retry",
  "catalog.state.forbidden": "You don't have access to the catalog",
  "catalog.state.notFound": "Product not found",

  // Product form
  "catalog.form.newTitle": "New product",
  "catalog.form.editTitle": "Edit product",
  "catalog.form.name": "Name (English)",
  "catalog.form.nameAr": "Name (Arabic)",
  "catalog.form.sku": "SKU",
  "catalog.form.category": "Category",
  "catalog.form.unit": "Unit",
  "catalog.form.unit.each": "Each",
  "catalog.form.unit.kg": "Kilogram",
  "catalog.form.price": "Price",
  "catalog.form.cost": "Cost",
  "catalog.form.vatApplicable": "VAT applicable",
  "catalog.form.barcodes": "Barcodes",
  "catalog.form.barcodePlaceholder": "Scan or type barcode",
  "catalog.form.barcodeRemove": "Remove barcode {code}",
  "catalog.form.variants": "Variants",
  "catalog.form.variantAdd": "Add variant",
  "catalog.form.inherit": "Inherit from product",
  "catalog.form.save": "Save",
  "catalog.form.saving": "Saving…",
  "catalog.form.cancel": "Cancel",
  "catalog.form.discardConfirm": "Discard unsaved changes?",
  "catalog.form.errorSummary": "Please fix the highlighted fields.",
  "catalog.form.priceChangeHint": "Past sales keep their original price.",

  // Archive / restore
  "catalog.archive.action": "Archive",
  "catalog.archive.confirmTitle": "Archive {name}?",
  "catalog.archive.confirmBody": "It will be hidden from the POS and search. Past sales and reports keep it.",
  "catalog.archive.confirm": "Archive",
  "catalog.restore.action": "Restore",
  "catalog.archive.done": "Product archived",
  "catalog.restore.done": "Product restored",

  // Conflicts
  "catalog.conflict.skuTaken": "SKU already used by {product}",
  "catalog.conflict.barcodeTaken": "Barcode already assigned to {product}",
  "catalog.conflict.barcodeDuplicateInForm": "This barcode is already in the list",
  "catalog.conflict.itemArchived": "This item is archived and not for sale",
  "catalog.conflict.staleWrite": "Someone else changed this product. Reload to see the latest version.",
  "catalog.lookup.barcodeNotFound": "Barcode {code} not found",
} as const;
