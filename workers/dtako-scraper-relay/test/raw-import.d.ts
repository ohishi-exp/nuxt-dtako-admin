/** Vite の `?raw` import (fixture の HTML をそのまま文字列で読む) の型。 */
declare module "*.html?raw" {
  const content: string;
  export default content;
}

/** xlsx fixture の base64 (relay は @types/node を持たず、バイナリを直に読めない)。 */
declare module "*.b64?raw" {
  const content: string;
  export default content;
}
