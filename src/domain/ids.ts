/** معرّف قصير فريد · نفس فكرة uid() في النموذج مع عشوائية أوسع */
export function uid(): string {
  const t = Date.now().toString(36);
  let r = '';
  for (let i = 0; i < 12; i++) r += Math.floor(Math.random() * 36).toString(36);
  return t + r;
}
