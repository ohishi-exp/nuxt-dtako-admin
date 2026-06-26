<script setup lang="ts">
import { useAuth } from '@ippoan/auth-client'
import { initApi } from '~/utils/api'

const { token } = useAuth()

onMounted(() => {
  // #434 step 2: rust-alc-api を直叩きせず Worker server route /api/proxy 経由にする。
  // proxy が auth-worker introspect で browser JWT を検証し、検証済み identity を
  // X-Tenant-ID + X-User-ID/Email/Role として注入する。client は X-Tenant-ID を
  // 手で載せない (proxy が上書きするため、信頼境界を proxy に寄せる)。Authorization
  // (Bearer token) だけは proxy が introspect 対象に取れるよう引き続き渡す。
  initApi('/api/proxy', () => token.value)
})
</script>

<template>
  <UApp>
    <NuxtLayout>
      <NuxtPage />
    </NuxtLayout>
  </UApp>
</template>
