/**
 * منع لقطة الشاشة (قرار المالك 2026-10-15 «٣»: «خيار في الإعدادات، مطفأ افتراضاً») · أندرويد وحده (AqariSecure.kt)
 */
import { NativeModules } from 'react-native';
import type { DB } from '../db/adapter';
import { getSetting } from '../repos/settings';

const mod = (NativeModules.AqariSecure as { setSecure(on: boolean): void } | undefined) ?? null;

export function applyScreenSecure(on: boolean): void {
  try { mod?.setSecure(on); } catch { /* منصة بلا الوحدة */ }
}

/** عند الإقلاع من إعداد الجهاز */
export function applyScreenSecureFrom(db: DB): void {
  applyScreenSecure(!!getSetting(db, 'blockScreenshots'));
}
