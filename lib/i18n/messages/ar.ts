import type { Messages } from "../types";

/** Arabic strings. Typed as `Messages`, so a missing or extra key fails typecheck. */
export const ar: Messages = {
  // Navigation
  "catalog.nav": "الكتالوج",
  "catalog.nav.products": "المنتجات",
  "catalog.nav.categories": "التصنيفات",

  // Product list
  "catalog.products.title": "المنتجات",
  "catalog.products.add": "إضافة منتج",
  "catalog.products.searchPlaceholder": "ابحث بالاسم أو رمز الصنف أو امسح الباركود",
  "catalog.products.column.name": "الاسم",
  "catalog.products.column.sku": "رمز الصنف",
  "catalog.products.column.barcode": "الباركود",
  "catalog.products.column.category": "التصنيف",
  "catalog.products.column.price": "السعر",
  "catalog.products.column.vat": "ضريبة القيمة المضافة",
  "catalog.products.column.status": "الحالة",
  "catalog.products.filter.category": "التصنيف",
  "catalog.products.filter.status": "الحالة",
  "catalog.products.filter.vat": "خاضع لضريبة القيمة المضافة",
  "catalog.products.filter.all": "الكل",
  "catalog.products.loadMore": "عرض المزيد",

  // Status and flags
  "catalog.status.active": "نشط",
  "catalog.status.archived": "مؤرشف",
  "catalog.vat.yes": "نعم",
  "catalog.vat.no": "لا",
  "catalog.category.none": "بدون تصنيف",

  // States
  "catalog.state.loading": "جارٍ تحميل المنتجات…",
  "catalog.state.empty.title": "لا توجد منتجات بعد",
  "catalog.state.empty.body": "أضف أول منتج لتبدأ البيع.",
  "catalog.state.noResults": "لا توجد نتائج مطابقة لـ «{q}»",
  "catalog.state.clearFilters": "مسح عوامل التصفية",
  "catalog.state.error": "حدث خطأ أثناء تحميل الكتالوج.",
  "catalog.state.retry": "إعادة المحاولة",
  "catalog.state.forbidden": "ليس لديك صلاحية الوصول إلى الكتالوج",
  "catalog.state.notFound": "المنتج غير موجود",

  // Product form
  "catalog.form.newTitle": "منتج جديد",
  "catalog.form.editTitle": "تعديل المنتج",
  "catalog.form.name": "الاسم (بالإنجليزية)",
  "catalog.form.nameAr": "الاسم (بالعربية)",
  "catalog.form.sku": "رمز الصنف",
  "catalog.form.category": "التصنيف",
  "catalog.form.unit": "الوحدة",
  "catalog.form.unit.each": "قطعة",
  "catalog.form.unit.kg": "كيلوجرام",
  "catalog.form.price": "السعر",
  "catalog.form.cost": "التكلفة",
  "catalog.form.vatApplicable": "خاضع لضريبة القيمة المضافة",
  "catalog.form.barcodes": "الباركود",
  "catalog.form.barcodePlaceholder": "امسح الباركود أو اكتبه",
  "catalog.form.barcodeRemove": "إزالة الباركود {code}",
  "catalog.form.variants": "الأنواع",
  "catalog.form.variantAdd": "إضافة نوع",
  "catalog.form.inherit": "مثل المنتج الأساسي",
  "catalog.form.save": "حفظ",
  "catalog.form.saving": "جارٍ الحفظ…",
  "catalog.form.cancel": "إلغاء",
  "catalog.form.discardConfirm": "تجاهل التغييرات غير المحفوظة؟",
  "catalog.form.errorSummary": "يرجى تصحيح الحقول المحددة.",
  "catalog.form.priceChangeHint": "تحتفظ المبيعات السابقة بسعرها الأصلي.",

  // Archive / restore
  "catalog.archive.action": "أرشفة",
  "catalog.archive.confirmTitle": "أرشفة {name}؟",
  "catalog.archive.confirmBody": "سيتم إخفاؤه من نقطة البيع والبحث، مع بقائه في المبيعات السابقة والتقارير.",
  "catalog.archive.confirm": "أرشفة",
  "catalog.restore.action": "استعادة",
  "catalog.archive.done": "تمت أرشفة المنتج",
  "catalog.restore.done": "تمت استعادة المنتج",

  // Conflicts
  "catalog.conflict.skuTaken": "رمز الصنف مستخدم بالفعل للمنتج {product}",
  "catalog.conflict.barcodeTaken": "الباركود مخصص بالفعل للمنتج {product}",
  "catalog.conflict.barcodeDuplicateInForm": "هذا الباركود موجود بالفعل في القائمة",
  "catalog.conflict.itemArchived": "هذا الصنف مؤرشف وغير متاح للبيع",
  "catalog.conflict.staleWrite": "قام مستخدم آخر بتعديل هذا المنتج. أعد التحميل لعرض أحدث نسخة.",
  "catalog.lookup.barcodeNotFound": "الباركود {code} غير موجود",
};
