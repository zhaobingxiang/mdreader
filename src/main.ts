import 'katex/dist/katex.min.css'
import 'highlight.js/styles/github.css'
import './styles/base.css'
import './styles/layout.css'
import './styles/preview.css'
import './styles/widgets.css'
import './styles/dark.css'
import { bootstrapApp } from './app'
import { getSettings } from './core/settings'
import { applyThemeSetting } from './core/theme'

// 先用 localStorage 镜像同步定一次主题，宿主真源到位后 app.ts 里再校正
applyThemeSetting(getSettings().theme)

const mount = document.getElementById('app')
if (!mount) throw new Error('缺少 #app 挂载点')

bootstrapApp(mount)
