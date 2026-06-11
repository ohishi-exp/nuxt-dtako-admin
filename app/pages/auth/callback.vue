<script setup lang="ts">
// callback の共通ロジック/UI は @ippoan/auth-client の AuthCallback に集約済み
// (Refs ippoan/auth-worker#257、nuxt-trouble との相互コピーを 1 本化)
import { AuthCallback } from '@ippoan/auth-client'

definePageMeta({ layout: 'auth' })
</script>

<template>
  <AuthCallback redirect-to="/operations" login-path="/login" />
</template>
