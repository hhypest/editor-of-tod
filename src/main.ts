import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import { installDiagnostics } from './services/diagnostics'

const app = createApp(App)
app.use(createPinia())
installDiagnostics(app)
app.mount('#app')
