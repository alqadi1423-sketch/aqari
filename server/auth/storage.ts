/**
 * تخزين خادم الهوية خلف واجهةٍ صغيرة على شكل تخزين الكائن الدائم في Cloudflare (Durable Object storage: get/put/delete/list
 * ببادئة) · فيُنقل إليه بلا تغيير في المنطق · والتنفيذ في الذاكرة للاختبارات وحدها.
 */
export interface AuthStorage {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<boolean>;
  /** كل ما يبدأ مفتاحه بالبادئة، مرتّباً بالمفتاح */
  list<T>(prefix: string): Promise<Map<string, T>>;
}

/** في الذاكرة · القيم تُنسخ عند الكتابة والقراءة فلا يغيّر المنادي ما خُزّن بلا put (كتخزين الكائن الدائم) */
export class MemoryAuthStorage implements AuthStorage {
  private data = new Map<string, unknown>();

  async get<T>(key: string): Promise<T | undefined> {
    return this.data.has(key) ? (structuredClone(this.data.get(key)) as T) : undefined;
  }

  async put<T>(key: string, value: T): Promise<void> {
    this.data.set(key, structuredClone(value));
  }

  async delete(key: string): Promise<boolean> {
    return this.data.delete(key);
  }

  async list<T>(prefix: string): Promise<Map<string, T>> {
    const out = new Map<string, T>();
    for (const k of [...this.data.keys()].sort()) if (k.startsWith(prefix)) out.set(k, structuredClone(this.data.get(k)) as T);
    return out;
  }

  /** كل ما خُزّن (للاختبار: أن الأسرار لا تُحفظ إلا بصماتٍ) */
  dump(): Record<string, unknown> {
    return Object.fromEntries([...this.data].map(([k, v]) => [k, structuredClone(v)]));
  }
}
