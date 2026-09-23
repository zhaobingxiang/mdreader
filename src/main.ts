import 'katex/dist/katex.min.css'
import 'highlight.js/styles/github.css'
import './styles/base.css'
import './styles/layout.css'
import './styles/preview.css'
import './styles/widgets.css'
import './styles/dark.css'
import { bootstrapApp } from './app'
import { initTheme } from './core/theme'

initTheme()

const mount = document.getElementById('app')
if (!mount) throw new Error('缺少 #app 挂载点')

bootstrapApp(mount)
