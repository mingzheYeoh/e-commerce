import { createApp } from 'vue'
import { createPinia } from 'pinia'
import gsap from 'gsap'
import { ScrollTrigger } from 'gsap/ScrollTrigger'
import App from './App.vue'
import { router } from './router'
import { refreshCatalogue } from './stores/catalog'
import { useCompareStore } from './stores/compare'
import './assets/css/main.css'

gsap.registerPlugin(ScrollTrigger)

const pinia = createPinia()

/** Stores that survive a reload. Each one exposes a `persist()` action. */
const PERSISTED = new Set(['cart', 'compare'])

/**
 * Mirrors those stores to storage after every mutation.
 *
 * A plugin rather than a call inside each action: `add`, `setQty` and `remove`
 * would each have to remember, and the one that forgot would lose a basket
 * silently. Subscribing catches every future action too.
 */
pinia.use(({ store }) => {
  if (!PERSISTED.has(store.$id)) return
  store.$subscribe(() => store.persist(), { detached: true })
})

createApp(App).use(pinia).use(router).mount('#app')

// After mount, so first paint comes from the build-time snapshot and never
// waits on the network. Once per page load; every consumer reads the result.
// The comparison may have held ids the snapshot did not know; with the live
// list in hand, anything still unknown is gone and is dropped. A failed fetch
// proves nothing about them, so they are kept.
void refreshCatalogue().then((live) => {
  if (!live) return
  const compare = useCompareStore()
  compare.setFromIds(compare.ids)
})
