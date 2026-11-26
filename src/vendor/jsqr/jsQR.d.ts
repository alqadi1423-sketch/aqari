/**
 * jsQR 1.4.0 (Apache-2.0 · https://github.com/cozmo/jsQR) · قارئ رموز QR بجافاسكربت خالصة، بلا وحدة أصلية ولا WebAssembly ولا شبكة
 * (المراجعة الشاملة 2026-11-13 · F · ٥.٥ الخيار أ · ق٠-٣) · jsQR.js هو dist/jsQR.js من حزمة npm كما هو، لم يُغيَّر منه حرف:
 *   npm pack jsqr@1.4.0 · integrity sha512-dxLob7q65Xg2DvstYkRpkYtmKm2sPJ9oFhrhmudT1dZvNFFTlroai3AWSpLey/w5vMcLBXRgOJsbXpdN9HzU/A==
 *   sha256(jsQR.js) = bc40c8a15196236b2314db0856f72ca0b49980cd5413b8c852a7349f5fee0859 (يفحصها tests/q0_3.noMlKit.test.ts)
 * ونُسخ إلى المستودع لا ثُبّت من npm: node_modules مشتركٌ ولا يُعاد تثبيته هنا، والملف وحده يكفي التطبيق والاختبار · الرخصة في LICENSE بجانبه.
 * وهذه الأنواع مختصرةٌ من dist/index.d.ts بما يستعمله التطبيق.
 */
export interface Point { x: number; y: number }

export interface QRCode {
  binaryData: number[];
  data: string;
  version: number;
  location: {
    topRightCorner: Point;
    topLeftCorner: Point;
    bottomRightCorner: Point;
    bottomLeftCorner: Point;
    topRightFinderPattern: Point;
    topLeftFinderPattern: Point;
    bottomLeftFinderPattern: Point;
    bottomRightAlignmentPattern?: Point;
  };
}

export interface Options {
  inversionAttempts?: 'dontInvert' | 'onlyInvert' | 'attemptBoth' | 'invertFirst';
}

declare function jsQR(data: Uint8ClampedArray, width: number, height: number, providedOptions?: Options): QRCode | null;
export default jsQR;
