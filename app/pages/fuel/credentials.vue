<script setup lang="ts">
/**
 * 給油データ USB アップローダー (Windows アプリ) の資格情報 (purpose `fuel-utran`) の発行・一覧・
 * rotate・失効 (Refs yhonda-ohishi/nginx#814)。以前は nuxt-leave の設定画面 (purpose `leave-scan` 固定)
 * にしか発行の口が無かった。
 *
 * 中身は部品 `MachineCredentials` (`/etc-cards` の複合機用 `etc-scan` と共有、Refs #1287)。
 * この画面は `fuel-utran` 固定で、用途は選ばせない (ETC の資格情報は `/etc-cards` で発行する)。
 */
</script>

<template>
  <div class="space-y-4">
    <div class="flex flex-wrap items-center gap-3">
      <h2 class="text-xl font-bold mr-auto">給油アップローダーの資格情報</h2>
      <UButton to="/fuel/intank" icon="i-lucide-fuel" variant="outline" label="インタンク燃料確認" />
    </div>

    <MachineCredentials purpose="fuel-utran" />
  </div>
</template>
