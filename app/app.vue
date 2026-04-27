<script setup lang="ts">
import { useAuth } from '@ippoan/auth-client'
import { initApi } from '~/utils/api'

const config = useRuntimeConfig()
const { token, orgId, isLoading } = useAuth()

onMounted(() => {
  initApi(
    config.public.apiBase as string,
    () => token.value,
    undefined,
    () => orgId.value,
  )
})
</script>

<template>
  <UApp>
    <div v-if="isLoading" key="auth-loading" class="flex items-center justify-center min-h-screen">
      <UIcon name="i-lucide-loader-circle" class="animate-spin size-8 text-gray-400" />
    </div>
    <NuxtLayout v-else key="layout">
      <NuxtPage />
    </NuxtLayout>
  </UApp>
</template>
