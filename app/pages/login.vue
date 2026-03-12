<script setup lang="ts">
definePageMeta({ layout: 'auth' })

const { loginWithGoogleRedirect } = useAuth()
</script>

<template>
  <UCard class="w-full max-w-sm">
    <div class="text-center space-y-4">
      <h1 class="text-2xl font-bold">デジタコ管理</h1>
      <p class="text-sm text-gray-500">北海大運 デジタコデータ管理システム</p>
      <UButton
        label="Google でログイン"
        icon="i-lucide-log-in"
        size="lg"
        block
        @click="loginWithGoogleRedirect()"
      />
    </div>
  </UCard>
</template>
