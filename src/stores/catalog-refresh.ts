import { defineStore } from 'pinia'
import { ref } from 'vue'

/** Refresh counters shared by registries, editors, setup and sheet previews. */
export const useCatalogRefreshStore = defineStore('catalogRefresh', () => {
  const signCatalogVersion = ref(0)
  const pu66CatalogVersion = ref(0)

  return { signCatalogVersion, pu66CatalogVersion }
})
