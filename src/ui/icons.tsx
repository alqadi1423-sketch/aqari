/**
 * أيقونات SVG · مسارات النموذج الأصلي منقولة إلى react-native-svg.
 * كل أزرار التطبيق تستخدمها بدل الرموز التعبيرية.
 */
import React from 'react';
import Svg, { Path, Circle, Rect } from 'react-native-svg';

export type IconName =
  | 'trash' | 'edit' | 'eye' | 'print' | 'export' | 'cancel' | 'clipboard' | 'archive'
  | 'undo' | 'card' | 'cash' | 'attach' | 'wrench' | 'wallet' | 'swap' | 'plus'
  | 'search' | 'back' | 'arrowBack' | 'dots' | 'home' | 'building' | 'contract' | 'collect' | 'menu'
  | 'calendar' | 'lock' | 'check' | 'pin' | 'bank' | 'tx' | 'settings' | 'library'
  | 'phone' | 'chat' | 'map' | 'claim' | 'message' | 'invoice' | 'supplier' | 'chart'
  | 'shield' | 'bell' | 'reload' | 'x' | 'bolt' | 'drop' | 'wifi' | 'filter';

const P: Record<IconName, React.ReactNode> = {
  trash: <Path d="M4 6h16M9 6V4h6v2m-8 0 1 14h8l1-14" />,
  edit: <Path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />,
  eye: <><Path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" /><Circle cx={12} cy={12} r={3} /></>,
  print: <Path d="M6 9V2h12v7M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2M6 14h12v8H6z" />,
  export: <Path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3" />,
  cancel: <><Circle cx={12} cy={12} r={10} /><Path d="M4.9 4.9l14.2 14.2" /></>,
  clipboard: <><Path d="M9 2h6a1 1 0 0 1 1 1v2H8V3a1 1 0 0 1 1-1z" /><Path d="M6 4h12a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z" /><Path d="M9 12h6M9 16h6" /></>,
  archive: <Path d="M21 8H3M21 8v11a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V8M21 8l-2-5H5L3 8M10 12h4" />,
  undo: <Path d="M3 7v6h6M3 13a9 9 0 1 0 3-7.7" />,
  card: <><Rect x={2} y={6} width={20} height={12} rx={2} /><Path d="M2 10h20" /></>,
  cash: <><Rect x={2} y={6} width={20} height={12} rx={2} /><Circle cx={12} cy={12} r={2.6} /><Path d="M6 12h.01M18 12h.01" /></>,
  attach: <Path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />,
  wrench: <Path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />,
  wallet: <><Path d="M21 12V7H5a2 2 0 0 1 0-4h14v4" /><Path d="M3 5v14a2 2 0 0 0 2 2h16v-5" /><Path d="M18 12a2 2 0 0 0 0 4h4v-4z" /></>,
  swap: <Path d="M7 7h13M7 7l3-3M7 7l3 3M17 17H4M17 17l-3-3M17 17l-3 3" />,
  plus: <Path d="M12 5v14M5 12h14" />,
  search: <><Circle cx={11} cy={11} r={7} /><Path d="M21 21l-4-4" /></>,
  back: <Path d="M9 5l7 7-7 7" />,
  // سهم رجوع مفرد رأسه إلى اليمين · مسار واحد بلا دائرة ولا قوس ولا عنصر ثانٍ
  arrowBack: <Path d="M4 12h15M12 5l7 7-7 7" />,
  dots: <><Circle cx={12} cy={5} r={1.6} /><Circle cx={12} cy={12} r={1.6} /><Circle cx={12} cy={19} r={1.6} /></>,
  home: <><Rect x={3} y={3} width={7} height={9} rx={1.5} /><Rect x={14} y={3} width={7} height={5} rx={1.5} /><Rect x={14} y={12} width={7} height={9} rx={1.5} /><Rect x={3} y={16} width={7} height={5} rx={1.5} /></>,
  building: <Path d="M3 21h18M5 21V7l7-4 7 4v14M9 21v-6h6v6M9 11h1M14 11h1" />,
  contract: <><Rect x={4} y={3} width={16} height={18} rx={1.5} /><Path d="M8 8h8M8 12h8M8 16h4" /></>,
  collect: <><Rect x={2} y={6} width={20} height={12} rx={2} /><Circle cx={12} cy={12} r={2.6} /><Path d="M6 12h.01M18 12h.01" /></>,
  menu: <Path d="M4 7h16M4 12h16M4 17h16" />,
  // قمع التصفية · زر التصفية في كل قائمة
  filter: <Path d="M3 5h18l-7 8v6l-4 2v-8z" />,
  calendar: <><Rect x={3} y={5} width={18} height={16} rx={2} /><Path d="M16 3v4M8 3v4M3 11h18" /></>,
  lock: <><Rect x={5} y={11} width={14} height={10} rx={2} /><Path d="M8 11V7a4 4 0 0 1 8 0v4" /></>,
  check: <Path d="M20 6L9 17l-5-5" />,
  pin: <><Path d="M12 22s-7-6.2-7-12a7 7 0 0 1 14 0c0 5.8-7 12-7 12z" /><Circle cx={12} cy={10} r={2.6} /></>,
  bank: <Path d="M3 10l9-6 9 6M4 10v10h16V10M9 21v-6h6v6" />,
  tx: <Path d="M7 7h13M7 7l3-3M7 7l3 3M17 17H4M17 17l-3-3M17 17l-3 3" />,
  settings: <><Circle cx={12} cy={12} r={3} /><Path d="M12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1" /></>,
  library: <Path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20V4a2 2 0 0 0-2-2H6.5A2.5 2.5 0 0 0 4 4.5v15zM4 19.5A2.5 2.5 0 0 0 6.5 22H20v-5" />,
  phone: <Path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.127.96.361 1.903.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0 1 22 16.92z" />,
  chat: <Path d="M21 11.5a8.4 8.4 0 0 1-8.9 8.4 8.6 8.6 0 0 1-3.4-.7L3 21l1.8-5.4A8.4 8.4 0 0 1 12 3a8.4 8.4 0 0 1 9 8.5z" />,
  map: <Path d="M9 4L3 6v14l6-2 6 2 6-2V4l-6 2-6-2zM9 4v14M15 6v14" />,
  claim: <Path d="M12 9v4M12 17h.01M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />,
  message: <Path d="M21 11.5a8.4 8.4 0 0 1-8.9 8.4 8.6 8.6 0 0 1-3.4-.7L3 21l1.8-5.4A8.4 8.4 0 0 1 12 3a8.4 8.4 0 0 1 9 8.5z" />,
  invoice: <><Rect x={5} y={3} width={14} height={18} rx={1.5} /><Path d="M8 8h8M8 12h8M8 16h5" /></>,
  supplier: <Path d="M3 9l2-6h14l2 6M3 9v10a1 1 0 0 0 1 1h16a1 1 0 0 0 1-1V9M3 9h18M9 13h6" />,
  chart: <Path d="M3 3v18h18M8 17V9M13 17V5M18 17v-7" />,
  shield: <Path d="M12 22s8-3.5 8-10V5l-8-3-8 3v7c0 6.5 8 10 8 10z" />,
  bell: <Path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9M13.7 21a2 2 0 0 1-3.4 0" />,
  reload: <Path d="M21 12a9 9 0 1 1-2.6-6.3M21 3v6h-6" />,
  x: <Path d="M6 6l12 12M18 6L6 18" />,
  bolt: <Path d="M13 2L4.5 13.5h6L11 22l8.5-11.5h-6L13 2z" />,
  drop: <Path d="M12 2.7S5.5 9.9 5.5 14.5a6.5 6.5 0 0 0 13 0C18.5 9.9 12 2.7 12 2.7z" />,
  wifi: <><Path d="M2.5 8.8a15.5 15.5 0 0 1 19 0M5.6 12.2a10.5 10.5 0 0 1 12.8 0M8.8 15.6a5.5 5.5 0 0 1 6.4 0" /><Circle cx={12} cy={19} r={1.3} /></>,
};

/**
 * رمز الريال السعودي الرسمي · الهندسة المعتمدة من البنك المركزي السعودي
 * (ملكية عامة). يُستخدم بدل الاختصار النصي في كل عرض للمبالغ.
 */
export function Riyal({ size = 12, color = '#232A36' }: { size?: number; color?: string }) {
  return (
    <Svg width={size * (1124.14 / 1256.39)} height={size} viewBox="0 0 1124.14 1256.39">
      <Path fill={color} d="M699.62,1113.02h0c-20.06,44.48-33.32,92.75-38.4,143.37l424.51-90.24c20.06-44.47,33.31-92.75,38.4-143.37l-424.51,90.24Z" />
      <Path fill={color} d="M1085.73,895.8c20.06-44.47,33.32-92.75,38.4-143.37l-330.68,70.33v-135.2l292.27-62.11c20.06-44.47,33.32-92.75,38.4-143.37l-330.68,70.27V66.13c-50.67,28.45-95.67,66.32-132.25,110.99v403.35l-132.25,28.11V0c-50.67,28.44-95.67,66.32-132.25,110.99v525.69l-295.91,62.88c-20.06,44.47-33.33,92.75-38.42,143.37l334.33-71.05v170.26l-358.3,76.14c-20.06,44.47-33.32,92.75-38.4,143.37l375.04-79.7c30.53-6.35,56.77-24.4,73.83-49.24l68.78-101.97v-.02c7.14-10.55,11.3-23.27,11.3-36.97v-149.98l132.25-28.11v270.4l424.53-90.28Z" />
    </Svg>
  );
}

export function Icon({
  name, size = 16, color = '#232A36', strokeWidth = 2,
}: { name: IconName; size?: number; color?: string; strokeWidth?: number }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none"
      stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round">
      {P[name]}
    </Svg>
  );
}
