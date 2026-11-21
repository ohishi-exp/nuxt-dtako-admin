<script setup lang="ts">
/**
 * theearth (web地球号) のログインフォーム。`TheearthSessionHeader` の右上パネルと、
 * /fuel/intank の「現在地」モーダル (未ログイン・セッション切れのとき) で共有する。
 * セッション状態は useTheearthSession (useState) で全ページ共有。
 */
const props = defineProps<{
  /** login を叩く API のベースパス (例 `/dvr-api`)。 */
  apiPrefix: string
  /**
   * ログイン成功時 (呼び出し側は `@login="..."` で渡す)。emit にしないのは、このフォームが
   * `v-if="!session"` の中に置かれ、ログインで session が立つと **emit より先に unmount される**
   * ため (Vue は unmount 済みの emit を捨てる。dev 実測でログイン後の再読込が呼ばれなかった)。
   */
  onLogin?: () => void
}>()

const { loginError, lastAccount, login } = useTheearthSession(props.apiPrefix)

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
    props.onLogin?.()
  }
  catch (e) {
    loginError.value = theearthSessionErrorMessage(e)
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
  <div>
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
  </div>
</template>
