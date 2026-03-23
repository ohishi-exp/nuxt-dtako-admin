<script setup lang="ts">
import { initApi } from '~/utils/api'

const config = useRuntimeConfig()
const { init, accessToken, tenantId, isLoading } = useAuth()

onMounted(async () => {
  initApi(
    config.public.apiBase as string,
    () => accessToken.value,
    undefined,
    () => tenantId.value,
  )
  await init()
})
</script>

<template>
  <UApp>
    <div v-if="isLoading" class="flex items-center justify-center min-h-screen">
      <UIcon name="i-lucide-loader-circle" class="animate-spin size-8 text-gray-400" />
    </div>
    <NuxtLayout v-else>
      <NuxtPage />
    </NuxtLayout>
  </UApp>
</template>
