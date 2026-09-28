import { createApp } from 'vue'
import App from './App.vue'
import { router } from './router'
// Reused, not duplicated: the console is the same product as the storefront,
// so it gets the storefront's own tokens and component classes rather than a
// second copy that could drift from them.
import '../../src/assets/css/main.css'
import { REDUCE_QUERY } from './motion'

// The storefront's CSS kill switch hangs off <html data-motion>; the console
// has no override, so the system setting writes it, and keeps writing it if
// the setting changes while the tab is open.
const reduce = window.matchMedia(REDUCE_QUERY)
const markMotion = () => (document.documentElement.dataset.motion = reduce.matches ? 'reduced' : 'full')
markMotion()
reduce.addEventListener('change', markMotion)

createApp(App).use(router).mount('#app')
