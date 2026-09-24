import { createApp } from 'vue'
import App from './App.vue'
import { router } from './router'
// Reused, not duplicated: the console is the same product as the storefront,
// so it gets the storefront's own tokens and component classes rather than a
// second copy that could drift from them.
import '../../src/assets/css/main.css'

createApp(App).use(router).mount('#app')
