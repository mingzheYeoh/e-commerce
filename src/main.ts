import { createApp } from 'vue'
import { createPinia } from 'pinia'
import gsap from 'gsap'
import { ScrollTrigger } from 'gsap/ScrollTrigger'
import App from './App.vue'
import './assets/css/main.css'

gsap.registerPlugin(ScrollTrigger)

createApp(App).use(createPinia()).mount('#app')
