<script setup lang="ts">
import { useAuth } from '@ippoan/auth-client'
import { initApi } from '~/utils/api'

const config = useRuntimeConfig()
const { token, orgId } = useAuth()

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
    <NuxtLayout>
      <NuxtPage />
    </NuxtLayout>
  </UApp>
</template>
