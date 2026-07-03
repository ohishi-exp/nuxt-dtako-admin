/**
 * 映像カードのクロップ (切り抜き・拡大表示) 機能。
 *
 * コンテナ (overflow:hidden) 内の `<video class="w-full h-auto">` に対し、
 * ドラッグで選択した矩形 (コンテナに対する 0..1 の割合) をコンテナいっぱいに
 * 拡大表示する。`<video>` 自体のレイアウトサイズは transform では変化しない
 * ため、コンテナは常にクロップ前と同じアスペクト比を保つ (video の
 * `w-full h-auto` が決めるボックスをそのまま使う)。
 */

export interface CropRect { x: number, y: number, w: number, h: number }

export function useVideoCrop() {
  const selecting = ref(false)
  const rect = ref<CropRect | null>(null)
  const dragStart = ref<{ x: number, y: number } | null>(null)
  const dragCurrent = ref<{ x: number, y: number } | null>(null)

  function toggleSelecting() {
    if (selecting.value) {
      selecting.value = false
      dragStart.value = null
      dragCurrent.value = null
      return
    }
    // 選択開始時は既存クロップを解除し、無加工の全体映像を見ながら選び直せるようにする
    rect.value = null
    selecting.value = true
  }

  function fractionFromEvent(e: MouseEvent, container: HTMLElement): { x: number, y: number } {
    const r = container.getBoundingClientRect()
    return {
      x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)),
      y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)),
    }
  }

  function onPointerDown(e: MouseEvent, container: HTMLElement | null) {
    if (!selecting.value || !container) return
    dragStart.value = fractionFromEvent(e, container)
    dragCurrent.value = dragStart.value
  }

  function onPointerMove(e: MouseEvent, container: HTMLElement | null) {
    if (!selecting.value || !dragStart.value || !container) return
    dragCurrent.value = fractionFromEvent(e, container)
  }

  function onPointerUp() {
    if (!selecting.value || !dragStart.value || !dragCurrent.value) return
    const x0 = Math.min(dragStart.value.x, dragCurrent.value.x)
    const y0 = Math.min(dragStart.value.y, dragCurrent.value.y)
    const x1 = Math.max(dragStart.value.x, dragCurrent.value.x)
    const y1 = Math.max(dragStart.value.y, dragCurrent.value.y)
    const w = x1 - x0
    const h = y1 - y0
    // 小さすぎる (ほぼクリックのみの) ドラッグは無視、選択モードは継続
    if (w > 0.03 && h > 0.03) {
      rect.value = { x: x0, y: y0, w, h }
      selecting.value = false
    }
    dragStart.value = null
    dragCurrent.value = null
  }

  function reset() {
    rect.value = null
    selecting.value = false
    dragStart.value = null
    dragCurrent.value = null
  }

  /** ドラッグ中に表示する選択矩形の CSS (%指定)。 */
  const dragBoxStyle = computed(() => {
    if (!dragStart.value || !dragCurrent.value) return null
    const x0 = Math.min(dragStart.value.x, dragCurrent.value.x) * 100
    const y0 = Math.min(dragStart.value.y, dragCurrent.value.y) * 100
    const x1 = Math.max(dragStart.value.x, dragCurrent.value.x) * 100
    const y1 = Math.max(dragStart.value.y, dragCurrent.value.y) * 100
    return {
      left: `${x0}%`,
      top: `${y0}%`,
      width: `${x1 - x0}%`,
      height: `${y1 - y0}%`,
    }
  })

  /** 確定したクロップ矩形をコンテナいっぱいに拡大する video 用 transform。 */
  const videoStyle = computed(() => {
    if (selecting.value || !rect.value) return {}
    const { x, y, w, h } = rect.value
    const scaleX = 1 / w
    const scaleY = 1 / h
    return {
      transformOrigin: 'top left',
      transform: `scale(${scaleX}, ${scaleY}) translate(${-x * 100}%, ${-y * 100}%)`,
    }
  })

  return {
    selecting,
    rect,
    toggleSelecting,
    onPointerDown,
    onPointerMove,
    onPointerUp,
    reset,
    dragBoxStyle,
    videoStyle,
  }
}
