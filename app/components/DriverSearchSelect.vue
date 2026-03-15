<script setup lang="ts">
import type { Driver } from '~/types'

const props = withDefaults(defineProps<{
  drivers: Driver[]
  modelValue: string
  valueKey?: 'id' | 'driver_cd'
  placeholder?: string
  width?: string
}>(), {
  valueKey: 'id',
  placeholder: 'すべて',
  width: 'w-44',
})

const emit = defineEmits<{
  'update:modelValue': [value: string]
}>()

const search = ref('')
const dropdown = ref(false)

const filteredDrivers = computed(() => {
  const q = search.value.toLowerCase()
  if (!q) return props.drivers
  return props.drivers.filter(d =>
    d.driver_name.toLowerCase().includes(q) || d.driver_cd.includes(q),
  )
})

function selectDriver(d: Driver) {
  emit('update:modelValue', d[props.valueKey])
  search.value = d.driver_name
  dropdown.value = false
}

function clear() {
  emit('update:modelValue', '')
  search.value = ''
}

function closeDropdown() {
  setTimeout(() => { dropdown.value = false }, 200)
}

// modelValue が外部から変更された場合に search を同期
watch(() => props.modelValue, (val) => {
  if (!val) {
    search.value = ''
    return
  }
  const d = props.drivers.find(d => d[props.valueKey] === val)
  if (d) search.value = d.driver_name
}, { immediate: true })

// drivers がロードされた後に modelValue に対応する名前をセット
watch(() => props.drivers, () => {
  if (props.modelValue) {
    const d = props.drivers.find(d => d[props.valueKey] === props.modelValue)
    if (d) search.value = d.driver_name
  }
})
</script>

<template>
  <div class="relative">
    <input
      v-model="search"
      type="text"
      :placeholder="placeholder"
      :class="['border rounded-lg px-3 py-1.5 text-sm dark:bg-gray-900 dark:border-gray-700', width]"
      @focus="dropdown = true"
      @input="dropdown = true"
      @blur="closeDropdown"
    >
    <button v-if="modelValue" class="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600" @click="clear">
      <UIcon name="i-lucide-x" class="size-3.5" />
    </button>
    <div v-if="dropdown" class="absolute z-10 mt-1 w-56 max-h-48 overflow-auto bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg">
      <button
        v-for="d in filteredDrivers"
        :key="d.id"
        class="w-full text-left px-3 py-1.5 text-sm hover:bg-gray-100 dark:hover:bg-gray-800"
        @mousedown.prevent="selectDriver(d)"
      >
        {{ d.driver_name }}
      </button>
      <div v-if="filteredDrivers.length === 0" class="px-3 py-2 text-xs text-gray-400">該当なし</div>
    </div>
  </div>
</template>
