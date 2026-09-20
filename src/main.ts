import { createApp } from 'vue'
import { createPinia } from 'pinia'
import gsap from 'gsap'
import { ScrollTrigger } from 'gsap/ScrollTrigger'
import App from './App.vue'
import { router } from './router'
import './assets/css/main.css'

gsap.registerPlugin(ScrollTrigger)

const pinia = createPinia()

/**
 * Mirrors the cart to storage after every mutation.
 *
 * A plugin rather than a call inside each action: `add`, `setQty` and `remove`
 * would each have to remember, and the one that forgot would lose a basket
 * silently. Subscribing catches every future action too.
 */
pinia.use(({ store }) => {
  if (store.$id !== 'cart') return
  store.$subscribe(() => store.persist(), { detached: true })
})

createApp(App).use(pinia).use(router).mount('#app')
