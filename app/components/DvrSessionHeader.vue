<script setup lang="ts">
/**
 * /dvr-viewer 系ページ共通のヘッダー (タイトル + ページ間ナビ + theearth ログイン
 * バッジ/パネル)。セッション状態は useDvrSession (useState) で全ページ共有。
 */
const props = defineProps<{ title: string }>()
const emit = defineEmits<{ login: [] }>()

const { session, loginError, showLoginPanel, lastLoginKick, lastAccount, login, logout } = useDvrSession()

const form = reactive({ compId: '', userName: '', userPass: '' })
const loggingIn = ref(false)

async function doLogin() {
  if (!form.compId || !form.userName || !form.userPass) {
    loginError.value = '会社ID / ユーザーID / パスワードをすべて入力してください'
    return
  }
  loggingIn.value = true
  loginError.value = null
  try {
    await login(form.compId, form.userName, form.userPass)
    form.userPass = ''
    emit('login')
  }
  catch (e) {
    loginError.value = dvrErrorMessage(e)
  }
  finally {
    loggingIn.value = false
  }
}

onMounted(() => {
  const last = lastAccount()
  form.compId = last.compId
  form.userName = last.userName
})
</script>

<template>
  <header class="border-b border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 sticky top-0 z-20">
    <div class="max-w-7xl mx-auto px-6 py-3 flex flex-wrap items-center gap-3">
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
    <div v-if="lastLoginKick" class="max-w-7xl mx-auto px-6 pb-3">
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
        <!-- name/autocomplete はブラウザのパスワードマネージャーが username+password を
             保存・自動入力できるようにするためのもの (会社ID は PM の対象外なので
             localStorage の前回値プリフィルで補完する)。 -->
        <form method="post" class="space-y-3" @submit.prevent="doLogin">
          <UFormField label="会社ID">
            <UInput v-model="form.compId" name="organization" autocomplete="organization" placeholder="例: 27324455" class="w-full" />
          </UFormField>
          <UFormField label="ユーザーID">
            <UInput v-model="form.userName" name="username" autocomplete="username" class="w-full" />
          </UFormField>
          <UFormField label="パスワード">
            <UInput v-model="form.userPass" name="password" type="password" autocomplete="current-password" class="w-full" />
          </UFormField>
          <div v-if="loginError" class="text-sm text-red-600 bg-red-50 dark:bg-red-950 rounded-lg p-3">
            {{ loginError }}
          </div>
          <UButton type="submit" block :loading="loggingIn" label="ログイン" />
        </form>
        <p class="text-xs text-gray-400 mt-3">
          入力した ID / パスワードは theearth へのログインにその場で 1 回だけ使われ、
          このサービスには保存されません。theearth 側は同一アカウントの同時ログインを
          許可しないため、他の場所でログイン中のセッションは切断されることがあります。
        </p>
      </UCard>
    </div>
  </header>
</template>
