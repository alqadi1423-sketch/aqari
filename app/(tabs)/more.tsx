/**
 * «المزيد» · فهرس الشاشات كلها مرتّبة أقساماً · وكل قسم يضم ما يخصه فقط.
 * روابط الشاشات تسكن هنا وحدها · صفحة الإعدادات للإعدادات وحدها.
 */
import React from 'react';
import { useRouter } from 'expo-router';
import { Screen } from '../../src/ui/Screen';
import { Card, CardTitle, SetRow } from '../../src/ui/components';
import type { IconName } from '../../src/ui/icons';

const SECTIONS: Array<{ title: string; items: Array<[string, string, string, IconName]> }> = [
  {
    title: 'العقار والتشغيل',
    items: [
      ['/units', 'الوحدات', 'كل الوحدات بحالتها وإيجارها', 'home'],
      ['/propmap', 'خريطة العقارات', 'مواقع العقارات بحالة إشغالها', 'map'],
      ['/form-templates', 'إنشاء النماذج', 'قوالب الاستلام والتسليم', 'clipboard'],
      ['/library', 'المكتبة', 'كل الملفات والصور مصنَّفة', 'library'],
    ],
  },
  {
    title: 'المال والفوترة',
    items: [
      ['/invoices', 'الفواتير', 'فواتير المبيعات وإصدارها', 'invoice'],
      ['/purchases', 'فواتير الشراء', 'المصروفات والالتزامات وسدادها', 'wrench'],
      ['/claims', 'المطالبات', 'مطالبات المستأجرين اليدوية والتلقائية', 'claim'],
      ['/banks', 'الحسابات البنكية', 'الحسابات وأرصدتها المشتقة', 'bank'],
      ['/transactions', 'الحركات البنكية', 'كشف الحركات الوارد والصادر', 'tx'],
      ['/reports', 'التقارير المالية', 'الدخل والميزانية والتدفقات', 'chart'],
    ],
  },
  {
    title: 'المحاسبة',
    items: [
      ['/accounts', 'دليل الحسابات', 'الحسابات وأرصدتها المشتقّة', 'wallet'],
      ['/journal', 'القيود اليومية', 'كل قيد وترحيله', 'contract'],
      ['/integrity', 'فحص المطابقة', 'يربط الدفتر بالعمليات', 'shield'],
    ],
  },
  {
    title: 'الأطراف والتواصل',
    items: [
      ['/tenants', 'المستأجرون', 'كل مستأجر بعقوده وأرصدته ومرفقاته', 'collect'],
      ['/suppliers', 'الموردون', 'الموردون وموردو الخدمات وعداداتهم', 'supplier'],
      ['/scripts', 'قوالب الرسائل', 'نصوص جاهزة برموز تستدعي البيانات', 'message'],
    ],
  },
  {
    title: 'النظام',
    items: [
      ['/company', 'بيانات المنشأة', 'الاسم والسجل والشعار والمستندات', 'building'],
      ['/audit-log', 'سجل العمليات', 'كل حركة، غير قابلة للتعديل', 'archive'],
      ['/perf', 'قياس الأداء', 'أزمنة التنقل والاستعلامات على جهازك', 'chart'],
      ['/settings', 'الإعدادات', 'النسخ الاحتياطي والتنبيهات والعرض', 'settings'],
    ],
  },
];

export default function More() {
  const router = useRouter();
  return (
    <Screen title="المزيد" noBack icon="menu">
      {SECTIONS.map((s) => (
        <Card key={s.title}>
          <CardTitle>{s.title}</CardTitle>
          {s.items.map(([path, title, sub, icon]) => (
            <SetRow key={path} icon={icon} title={title} sub={sub} onPress={() => router.push(path as never)} />
          ))}
        </Card>
      ))}
    </Screen>
  );
}
