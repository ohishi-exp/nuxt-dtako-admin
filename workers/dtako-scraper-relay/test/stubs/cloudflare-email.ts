// `cloudflare:email` の test stub (vitest.config.ts の alias、Refs #1206)。Workers の
// EmailMessage は引数を保持して send_email binding へ渡されるだけなので、同じ形で持つ。
export class EmailMessage {
  constructor(
    readonly from: string,
    readonly to: string,
    readonly raw: ReadableStream | string,
  ) {}
}
