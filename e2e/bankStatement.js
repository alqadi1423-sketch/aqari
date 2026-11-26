#!/usr/bin/env node
/**
 * الجوال الافتراضي · ١٢ (التوجيه الرابع ٦ · ٢): كشف حسابٍ مصطنع بصيغة CSV يُدفع إلى «التنزيلات» في المحاكي فيقرؤه التطبيق من «كشف
 * الحساب والمطابقة» · بيانات مصطنعة بحروفٍ لاتينية، والافتتاحي مع الحركات يساوي الختامي.
 * الاستعمال: node e2e/bankStatement.js <ملف.csv>
 */
const fs = require('fs');

const rows = [
  'Opening Balance,0.00',
  'Date,Description,Debit,Credit,Balance',
  '2026-11-02,E2E Deposit,,500.00,500.00',
  '2026-11-05,E2E Fee,15.00,,485.00',
  'Closing Balance,485.00',
];
fs.writeFileSync(process.argv[2], rows.join('\n') + '\n');
