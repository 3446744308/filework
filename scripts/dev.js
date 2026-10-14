import { spawn } from 'node:child_process'
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const children = []

const devPort = process.env.PORT || '3000'
const devDataDir = process.env.DATA_DIR || 'data-dev'
const devEnv = { ...process.env, PORT: devPort, DATA_DIR: devDataDir }

function run(label, args, cwd = rootDir) {
  const child = spawn(process.execPath, args, { cwd, stdio: 'inherit', shell: false, env: devEnv })
  child.on('exit', (code) => {
    console.log(`[${label}] 进程退出，code=${code}`)
    shutdown()
  })
  children.push(child)
  return child
}

function shutdown() {
  for (const child of children) {
    if (!child.killed) child.kill('SIGTERM')
  }
  process.exit(0)
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

const viteBin = path.join(rootDir, 'node_modules', 'vite', 'bin', 'vite.js')
if (!fs.existsSync(viteBin)) {
  console.error('未找到 vite，请先执行: npm install')
  process.exit(1)
}

console.log('开发模式启动中...')
console.log(`后端: http://localhost:${devPort}   前端: http://localhost:5173`)
console.log(`开发数据目录: ${path.resolve(rootDir, devDataDir)}（与生产 DATA_DIR 隔离，首次启动为空）`)
console.log('如需改用生产数据目录: DATA_DIR=data npm run dev')
run('server', ['server/index.js'])
run('vite', [viteBin])
