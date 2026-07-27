<script setup lang="ts">
/**
 * 画面に入るまで中身を描かない入れ物 (Refs #472)。
 *
 * タイムカード表はドライバーを混ぜて **134 人 × 30 日 × 8 列 = 3 万セル超**になり、
 * 一度に DOM へ載せるとメインスレッドが止まってスクロールも効かなくなる
 * (2026-07-27 に本番で確認)。**見えているシートだけ描く。**
 *
 * - 高さは `min-height` で先に確保する — 描画前後でスクロール位置が飛ばないため。
 *   実測に近い値を親から渡す (ズレても IntersectionObserver が追随する)
 * - **一度描いたら消さない。** スクロールで往復するたびに作り直すと、そちらの方が重い
 * - **印刷では全部描く。** `force` を立てると即座に中身を出す。紙は一覧が揃っていないと
 *   意味がないため (親が印刷前に立てる)
 * - `IntersectionObserver` が無い環境 (SSR・古いブラウザ) では最初から描く —
 *   遅くなるだけで壊れないほうへ倒す
 *
 * **名前に `Lazy` を使わないこと。** `<LazyFoo>` は Nuxt が予約している接頭辞
 * (= `Foo` を遅延読み込みする) なので、`LazyRender` という名前にすると `Render` という
 * 別コンポーネントを探しに行って解決に失敗する (2026-07-27 に dev で踏んだ)。
 */
const props = withDefaults(defineProps<{
  /** 描く前に確保しておく高さ (CSS 値)。 */
  minHeight?: string
  /** 立てると即座に描く (印刷用)。 */
  force?: boolean
  /** 画面の何 px 手前から描き始めるか。 */
  rootMargin?: string
}>(), {
  minHeight: '20rem',
  force: false,
  rootMargin: '600px',
})

const root = ref<HTMLElement | null>(null)
const shown = ref(false)
let observer: IntersectionObserver | null = null

watch(() => props.force, (on) => {
  if (on) shown.value = true
}, { immediate: true })

onMounted(() => {
  if (shown.value) return
  // 実装が無ければ最初から描く。`globalThis` から取るのは、差し替えたときに確実に
  // そちらを見るため (テストで偽物を挿す)
  const Observer = (globalThis as { IntersectionObserver?: typeof IntersectionObserver })
    .IntersectionObserver
  if (typeof Observer !== 'function') {
    shown.value = true
    return
  }
  observer = new Observer((entries) => {
    if (!entries.some(e => e.isIntersecting)) return
    shown.value = true
    observer?.disconnect()
    observer = null
  }, { rootMargin: props.rootMargin })
  if (root.value) observer.observe(root.value)
})

onBeforeUnmount(() => {
  observer?.disconnect()
  observer = null
})
</script>

<template>
  <div ref="root" :style="shown ? undefined : { minHeight }">
    <slot v-if="shown" />
  </div>
</template>
