/**
 * بنود فاتورة الشراء في نموذجها (الهجرة ٢٩ · قرار المالك: جدول البنود الجديد، والفاتورة بلا بنود كما هي) ·
 * اختيارية: ما يصير منها أصلاً يُقيَّد على حساب فئته · وكل نصٍّ بمفتاحه في ملفي الترجمة.
 */
import React from 'react';
import { View } from 'react-native';
import type { DB } from '../db/adapter';
import { BtnGhost, Note, T } from './components';
import { C, TYPE } from './theme';
import { useLang } from '../i18n';
import { fmt, toHalalas } from '../domain/money';
import { LinesEditor, emptyLine, type LineDraft } from './AssetSheets';
import { purchaseLinesOf } from '../domain/assets/purchaseLines';

/** بنود فاتورةٍ محفوظة مسوّدةً للنموذج · والبند الذي أثبت تكلفة أصلٍ قائم يبقى مربوطاً به */
export function loadLineDrafts(db: DB, purchaseId: string): LineDraft[] {
  return purchaseLinesOf(db, purchaseId).map((l) => {
    const linked = db.get<{ id: string }>(
      `SELECT id FROM assets WHERE purchase_line_id = ? AND source NOT IN ('purchase', 'convert') AND deleted_at IS NULL`, [l.id]);
    return {
      descr: l.descr, qty: String(l.qty), amount: fmt(Number(l.amount_halalas)).replace(/,/g, ''), isAsset: !!l.is_asset,
      category: l.asset_category ?? '', unitId: l.unit_id ?? '', room: l.room, linkAssetId: linked?.id ?? '',
    };
  });
}

export function PurchaseLinesSection({ lines, onChange, baseHalalas }: { lines: LineDraft[]; onChange: (l: LineDraft[]) => void; baseHalalas: number }) {
  const { t } = useLang();
  const sum = lines.reduce((s, l) => s + toHalalas(l.amount), 0);
  return (
    <View style={{ marginVertical: 8 }}>
      <T size={TYPE.body} bold>{t('assets.lines.title')}</T>
      {!lines.length ? (
        <>
          <T size={TYPE.caption} color={C.muted} style={{ marginBottom: 6 }}>{t('assets.lines.note')}</T>
          <BtnGhost small icon="plus" title={t('assets.convert.addLine')} onPress={() => onChange([{ ...emptyLine(), amount: baseHalalas ? fmt(baseHalalas).replace(/,/g, '') : '' }])} />
        </>
      ) : (
        <>
          <LinesEditor lines={lines} onChange={onChange} allowLink />
          {sum !== baseHalalas ? <Note tone="danger">{t('assets.lines.sum', { sum: fmt(sum), base: fmt(baseHalalas) })}</Note> : null}
        </>
      )}
    </View>
  );
}
