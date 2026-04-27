<script setup lang="ts">
import { useAuth } from '@ippoan/auth-client'

const { username, logout } = useAuth()
const route = useRoute()

const navigation = [
  { label: 'アップロード', icon: 'i-lucide-upload', to: '/upload' },
  { label: '運行一覧', icon: 'i-lucide-truck', to: '/operations' },
  { label: '日別稼働', icon: 'i-lucide-clock', to: '/daily-hours' },
  { label: '拘束時間管理表', icon: 'i-lucide-shield-check', to: '/restraint-report' },
  { label: 'CSV比較', icon: 'i-lucide-git-compare', to: '/restraint-compare' },
  { label: 'イベント分類', icon: 'i-lucide-settings', to: '/event-classifications' },
  { label: 'スクレイプ', icon: 'i-lucide-download', to: '/scraper' },
]

function handleLogout() {
  logout()
}
</script>

<template>
  <div class="flex min-h-screen">
    <!-- Sidebar -->
    <aside class="w-60 border-r border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 flex flex-col">
      <div class="p-4 border-b border-gray-200 dark:border-gray-800">
        <h1 class="text-lg font-bold">デジタコ管理</h1>
      </div>

      <nav class="flex-1 p-2">
        <NuxtLink
          v-for="item in navigation"
          :key="item.to"
          :to="item.to"
          class="flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition-colors"
          :class="route.path.startsWith(item.to)
            ? 'bg-blue-50 dark:bg-blue-950 text-blue-700 dark:text-blue-300 font-medium'
            : 'text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800'"
        >
          <UIcon :name="item.icon" class="size-5" />
          {{ item.label }}
        </NuxtLink>
      </nav>

      <!-- User -->
      <div class="p-4 border-t border-gray-200 dark:border-gray-800">
        <div class="text-sm text-gray-600 dark:text-gray-400 truncate mb-2">
          {{ username }}
        </div>
        <UButton
          label="ログアウト"
          icon="i-lucide-log-out"
          variant="ghost"
          size="sm"
          block
          @click="handleLogout"
        />
      </div>
    </aside>

    <!-- Main content -->
    <main class="flex-1 p-6 bg-gray-50 dark:bg-gray-950 overflow-auto">
      <slot />
    </main>
  </div>
</template>
