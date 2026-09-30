import { createApp } from 'vue'
import App from './App.vue'
import { installDiagnostics } from './services/diagnostics'

const app = createApp(App)
installDiagnostics(app)
app.mount('#app')
