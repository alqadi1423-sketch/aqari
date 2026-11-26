/**
 * قراءة رموز الصورة (التوجيه الرابع ٦ · ١ · «قراءة فاتورة الشراء بـQR أولاً») على الجهاز نفسه بلا شبكة ولا قوقل (ق٠-٣ · المراجعة
 * الشاملة 2026-11-13 · F · ٥.٥ الخيار أ): كانت بـML Kit، وهو يرسل إلى قوقل بيانات استعمالٍ تقنية (F-2)، فصارت بجافاسكربت خالصة:
 * تصغّر expo-image-manipulator (المثبّت أصلاً، وبه تُصنع المصغّرات) الصورة وتحفظها PNG في ذاكرة التطبيق المؤقتة، فتُقرأ بايتاتها
 * ويفكّها jsQR (domain/qrImage.ts)، ثم يُحذف الملف المؤقت · الصورة لا تخرج من الجوال، ولا مكتبة تتصل بشيء.
 * والقراءة بمرورين: الضلع الأطول ١٦٠٠ ثم ٢٤٠٠ لرمزٍ صغيرٍ في الصورة (qrPassSides) · وما يُحفظ من نتيجتها (الفاتورة، والصورة إن
 * أُرفقت) يتبع المزامنة كبقية البيانات (مدقق المرحلة ٠ · P0-10) · تعيد قيم الرموز، ويختار منها pickZatcaQr رمز الهيئة ·
 * وترمي «qr-unavailable» إن غاب المصغِّر (حزمةٌ بلا وحدته الأصلية)، و«qr-read» إن تعذّرت قراءة الصورة.
 * dims أبعاد الصورة إن عرفها المنتقي (يُصغَّر ضلعها الأطول ولا تُكبَّر صورةٌ أصغر).
 */
export async function readQrFromImage(uri: string, dims?: { width?: number; height?: number }): Promise<string[]> {
  type Manip = typeof import('expo-image-manipulator');
  let manipulate: Manip['manipulateAsync'];
  let PNG: Manip['SaveFormat']['PNG'];
  try {
    const mod = await import('expo-image-manipulator');
    // والوحدة غير المربوطة يستورد جزؤها المكتوب ويرمي عند أول وصولٍ لخاصية: يُطلب هنا لا عند الاستدعاء (المدقق الخارجي J٩)
    const fn = mod.manipulateAsync;
    if (typeof fn !== 'function') throw new Error('qr-unavailable');
    manipulate = fn;
    PNG = mod.SaveFormat.PNG;
  } catch {
    throw new Error('qr-unavailable');
  }
  const { File } = await import('expo-file-system');
  const { qrValuesFromPng, qrPassSides } = await import('../domain/qrImage');
  const { decodeZatcaQr } = await import('../domain/zatcaQr');
  const w = dims?.width ?? 0, h = dims?.height ?? 0;
  const values: string[] = [];
  for (const side of qrPassSides(w, h)) {
    // الضلع الأطول إلى side · وبأبعادٍ مجهولة يُصغَّر العرض (صورة الكاميرا القائمة يصير ضلعها الأطول أكبر قليلاً، والمرور الثاني يكفيها)
    const resize = side == null ? [] : [{ resize: h > w ? { height: side } : { width: side } }];
    let bytes: Uint8Array;
    try {
      const out = await manipulate(uri, resize, { format: PNG, compress: 1 });
      const tmp = new File(out.uri);
      try { bytes = tmp.bytesSync(); } finally { try { tmp.delete(); } catch { /* ملفٌ مؤقت في ذاكرة التطبيق المؤقتة */ } }
    } catch { throw new Error('qr-read'); }
    let found: string[];
    try { found = qrValuesFromPng(bytes, { wanted: (v) => decodeZatcaQr(v).ok }); } catch { throw new Error('qr-read'); }
    for (const v of found) if (!values.includes(v)) values.push(v);
    // رمز الهيئة وُجد: لا مرور بعده (رابط المتجر وحده لا يوقف البحث عن رمز الفاتورة)
    if (values.some((v) => decodeZatcaQr(v).ok)) break;
  }
  return values;
}

/** قيم الرموز في ملف فاتورة إلكترونية (XML، أو PDF يضمّنه) على الجهاز · لا شبكة (domain/invoiceFile.ts) */
export async function readQrFromInvoiceFile(file: { uri: string; name: string; mime: string }): Promise<string[]> {
  const { File } = await import('expo-file-system');
  const { qrValuesFromInvoiceFile, invoiceFileKind } = await import('../domain/invoiceFile');
  let bytes: Uint8Array;
  try { bytes = new File(file.uri).bytesSync(); } catch { throw new Error('qr-read'); }
  // والإشعار الدائن ليس فاتورة شراء (المدقق الخارجي J٦)
  if (invoiceFileKind(bytes, file.name, file.mime) === 'credit') throw new Error('qr-credit');
  return qrValuesFromInvoiceFile(bytes, file.name, file.mime);
}
