/**
 * قراءة ملف إيجار العقد الجديد في نافذة التجديد (المراجعة الشاملة 2026-11-13 · A1-9 · قرار المالك 2026-10-05): بالمسار نفسه لقراءة العقد
 * الجديد (scanContractFile)، فتُملأ خانات التجديد وتؤخذ تواريخ الأقساط من جدول الملف، وإن تعذّر جدوله حُسبت ونُبّه عليها.
 */
import React, { useState } from 'react';
import { View } from 'react-native';
import * as DocumentPicker from 'expo-document-picker';
import { File } from 'expo-file-system';
import { BtnGhost, T } from './components';
import { C } from './theme';
import { scanContractFile } from '../services/contractScan';
import { isOcrStopped } from '../services/imageText';
import { whilePrompting } from '../services/appLockService';
import { parseEjarExtras, revenueSplitOf } from '../domain/pdf/ejarExtras';
import type { ScheduleRow } from '../domain/pdf/parseEjar';
import { useLang } from '../i18n';

export interface RenewFileRead {
  ejarNo?: string;
  start?: string;
  end?: string;
  valueHalalas?: number;
  cycle?: string;
  /** null = قُرئ الملف وتعذّر جدوله */
  schedule: ScheduleRow[] | null;
  servicesHalalas?: number;
  parkingHalalas?: number;
  /** الملف نفسه يُرفق بالعقد الجديد بعد التجديد */
  file: { uri: string; name: string; mime: string };
}

export function RenewEjarRead({ onRead }: { onRead: (r: RenewFileRead) => void }) {
  const { t } = useLang();
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);
  const pick = async () => {
    try {
      const res = await whilePrompting(() => DocumentPicker.getDocumentAsync({ type: ['application/pdf', 'image/*'], copyToCacheDirectory: true }));
      if (res.canceled || !res.assets?.length) return;
      const asset = res.assets[0];
      setBusy(true);
      setStatus(null);
      await new Promise((r) => setTimeout(r, 50));
      const isPdf = /\.pdf$/i.test(asset.name ?? '') || asset.mimeType === 'application/pdf';
      const bytes = isPdf ? new File(asset.uri).bytesSync() : undefined;
      const { text, result } = await scanContractFile({ uri: asset.uri, mimeType: asset.mimeType, name: asset.name, bytes });
      if (!result.found.length) { setStatus({ ok: false, text: t('lease.renewFileEmpty') }); return; }
      const split = revenueSplitOf(parseEjarExtras(text));
      onRead({
        ejarNo: result.contractNo, start: result.start, end: result.end, valueHalalas: result.valueHalalas, cycle: result.cycle,
        schedule: result.schedule ?? null,
        servicesHalalas: split.servicesHalalas ?? 0, parkingHalalas: split.parkingHalalas ?? 0,
        file: { uri: asset.uri, name: asset.name ?? 'lease.pdf', mime: asset.mimeType ?? '' },
      });
      setStatus(result.schedule
        ? { ok: true, text: t('lease.renewFileRead', { n: result.schedule.length }) }
        : { ok: false, text: t('lease.renewFileNoSchedule') });
    } catch (e) {
      const code = e instanceof Error ? e.message : '';
      setStatus({ ok: false, text: isOcrStopped(e) ? t('contractScan.ocrStopped')
        : code === 'pdf-empty' ? t('contractScan.pdfEmpty') : t('lease.renewFileFailed') });
    } finally {
      setBusy(false);
    }
  };
  return (
    <View style={{ backgroundColor: C.paper, borderRadius: 8, padding: 10, marginBottom: 12 }}>
      <BtnGhost small icon="contract" title={t('lease.renewReadFile')} onPress={pick} disabled={busy} />
      {status ? <T size={11} color={status.ok ? C.emerald : C.rose} style={{ marginTop: 5 }}>{status.text}</T> : null}
    </View>
  );
}
