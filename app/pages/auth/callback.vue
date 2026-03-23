<script setup lang="ts">
definePageMeta({ layout: 'auth' })

const { handleCallback } = useAuth()
const error = ref<string | null>(null)

onMounted(() => {
  const success = handleCallback()
  if (success) {
    navigateTo('/operations')
  } else {
    error.value = '認証に失敗しました。再度ログインしてください。'
  }
})
</script>

<template>
  <UCard class="w-full max-w-sm">
    <div class="text-center space-y-4">
      <template v-if="error">
        <UIcon name="i-lucide-alert-circle" class="size-12 text-red-500 mx-auto" />
        <p class="text-red-600">{{ error }}</p>
        <UButton label="ログインに戻る" to="/login" variant="outline" />
      </template>
      <template v-else>
        <UIcon name="i-lucide-loader-circle" class="size-12 animate-spin text-gray-400 mx-auto" />
        <p class="text-gray-500">認証中...</p>
      </template>
    </div>
  </UCard>
</template>
