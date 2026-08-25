/** wrangler の rules (type = "Data") で同梱する .otf の型 (Refs #874-2)。
 * Workers ランタイムでは Data module の default export は ArrayBuffer。
 * node vitest 側は vitest.config.ts の `otf-data-module` plugin が同じ形
 * (default export = ArrayBuffer) で解決する。 */
declare module "*.otf" {
  const data: ArrayBuffer;
  export default data;
}
