<script setup lang="ts">
/**
 * theearth ログインバッジ/パネル付きのページヘッダー (タイトル + ログイン状態)。
 * /dvr-viewer 系ページと /daily-report-edit で共有する (Refs #233。かつての
 * DvrSessionHeader.vue / DailyReportSessionHeader.vue は完全な重複だった)。
 * セッション状態は useTheearthSession (useState) で全ページ共有。
 */
const props = defineProps<{
  title: string
  /** login/logout を叩く API のベースパス (例 `/dvr-api`)。どの prefix でも
   * worker 側は同一セッションレコードに落ちる (useTheearthSession 参照)。 */
  apiPrefix: string
  /** true でコンテンツ幅の上限 (max-w-7xl) を外す (日報編集のような全幅ページ用)。 */
  wide?: boolean
}>()
const emit = defineEmits<{ login: [] }>()

const { session, showLoginPanel, lastLoginKick, logout } = useTheearthSession(props.apiPrefix)
</script>

<template>
  <header class="border-b border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 sticky top-0 z-20">
    <div class="px-6 py-3 flex flex-wrap items-center gap-3" :class="props.wide ? '' : 'max-w-7xl mx-auto'">
      <h1 class="text-lg font-bold">
        {{ props.title }}
      </h1>
      <div class="flex-1" />

      <!-- 右上: ログイン状態表示 + ボタン -->
      <template v-if="session">
        <span class="inline-flex items-center gap-1.5 text-sm rounded-full px-3 py-1 bg-green-100 text-green-700 dark:bg-green-950 dark:text-green-300">
          <span class="size-2 rounded-full bg-green-500" />
          ログイン中: {{ session.compId }} / {{ session.userName }}
        </span>
        <UButton size="xs" color="neutral" variant="soft" icon="i-lucide-log-out" label="ログアウト" @click="logout" />
      </template>
      <template v-else>
        <span class="inline-flex items-center gap-1.5 text-sm rounded-full px-3 py-1 bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-400">
          <span class="size-2 rounded-full bg-gray-400" />
          未ログイン
        </span>
        <UButton
          size="sm"
          icon="i-lucide-log-in"
          :label="showLoginPanel ? '閉じる' : 'ログイン'"
          @click="showLoginPanel = !showLoginPanel"
        />
      </template>
    </div>

    <!-- ライセンス数超過等による自動 kick 通知 (Refs #169、手動で閉じるまで表示) -->
    <div v-if="lastLoginKick" class="px-6 pb-3" :class="props.wide ? '' : 'max-w-7xl mx-auto'">
      <div class="flex items-center justify-between gap-3 text-sm text-amber-700 bg-amber-50 dark:bg-amber-950 dark:text-amber-300 rounded-lg px-3 py-2">
        <span>
          {{ lastLoginKick.kickedUserName
            ? `ライセンス数超過のため既存セッション (${lastLoginKick.kickedUserName}) を強制ログアウトしてログインしました`
            : '同一アカウントの別セッションを強制ログアウトしてログインしました' }}
        </span>
        <UButton size="xs" color="neutral" variant="ghost" icon="i-lucide-x" @click="lastLoginKick = null" />
      </div>
    </div>

    <!-- 右上から出るログインパネル (未ログイン時のみ) -->
    <div v-if="!session && showLoginPanel" class="absolute right-4 top-full mt-2 w-96 max-w-[calc(100vw-2rem)] z-30">
      <UCard class="shadow-xl">
        <template #header>
          <span class="font-semibold">theearth (web地球号) にログイン</span>
        </template>
        <TheearthLoginForm :api-prefix="props.apiPrefix" @login="emit('login')" />
      </UCard>
    </div>
  </header>
</template>
