/** Vite の `?raw` import (fixture の HTML をそのまま文字列で読む) の型。 */
declare module "*.html?raw" {
  const content: string;
  export default content;
}
