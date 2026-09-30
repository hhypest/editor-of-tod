// Собирает переносной исполняемый файл (Node.js single executable application).
// Использование: npm run build:exe [-- --target win-x64|host]
// По умолчанию собирается Windows x64. Интерфейс из dist/ встраивается в файл,
// данные при запуске создаются в private-data рядом с программой.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { inject } from 'postject'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const releaseDirectory = join(root, 'release')
const work = join(releaseDirectory, '.sea')
const cache = join(releaseDirectory, '.cache')
const fuse = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2'

const targetIndex = process.argv.indexOf('--target')
const target = targetIndex >= 0 ? process.argv[targetIndex + 1] : 'win-x64'
if (target !== 'win-x64' && target !== 'host') {
  throw new Error(`Неизвестная цель ${target}: используйте win-x64 или host.`)
}
const windows = target === 'win-x64' || process.platform === 'win32'
const outputName =
  target === 'win-x64'
    ? 'editor-of-tod.exe'
    : `editor-of-tod-${process.platform}-${process.arch}${windows ? '.exe' : ''}`

const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const dist = join(root, 'dist')
if (!existsSync(join(dist, 'index.html'))) {
  throw new Error('Нет сборки интерфейса dist/: сначала выполните npm run build-only.')
}
mkdirSync(work, { recursive: true })
mkdirSync(cache, { recursive: true })

// 1. Сервер и зависимости в один CommonJS-файл.
const bundle = join(work, 'app.cjs')
await build({
  entryPoints: [join(root, 'server', 'desktop.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node24',
  outfile: bundle,
  legalComments: 'none',
  define: { __TOD_VERSION__: JSON.stringify(packageJson.version) },
  // import.meta.url нужен только при запуске из исходников; в исполняемом файле
  // интерфейс читается из встроенных ресурсов, а данные — рядом с программой.
  logOverride: { 'empty-import-meta': 'silent' },
  logLevel: 'warning',
})

// 2. Интерфейс как ресурсы SEA.
function files(directory) {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name)
    return statSync(path).isDirectory() ? files(path) : [path]
  })
}
const assets = Object.fromEntries(
  files(dist).map((path) => [`dist/${relative(dist, path).split(sep).join('/')}`, path]),
)
const blob = join(work, 'sea-prep.blob')
const config = join(work, 'sea-config.json')
writeFileSync(
  config,
  JSON.stringify(
    {
      main: bundle,
      output: blob,
      disableExperimentalSEAWarning: true,
      useSnapshot: false,
      useCodeCache: false,
      assets,
    },
    null,
    2,
  ),
)
execFileSync(process.execPath, ['--experimental-sea-config', config], { stdio: 'inherit' })

// 3. Исполняемый файл Node.js той же версии, что создала blob.
function windowsNode() {
  if (process.platform === 'win32' && process.arch === 'x64') return process.execPath
  const version = process.versions.node
  const unpacked = join(cache, `node-win-x64-${version}`)
  const binary = join(unpacked, 'package', 'bin', 'node.exe')
  if (!existsSync(binary)) {
    mkdirSync(unpacked, { recursive: true })
    const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
    const tarball = execFileSync(
      npm,
      ['pack', `node-win-x64@${version}`, '--pack-destination', unpacked, '--silent'],
      { encoding: 'utf8', shell: process.platform === 'win32' },
    )
      .trim()
      .split('\n')
      .at(-1)
    execFileSync('tar', ['-xzf', join(unpacked, tarball), '-C', unpacked], { stdio: 'inherit' })
  }
  return binary
}
const sourceBinary = target === 'win-x64' ? windowsNode() : process.execPath
const output = join(releaseDirectory, outputName)
copyFileSync(sourceBinary, output)

// 4. Внедрение blob в копию node.
await inject(output, 'NODE_SEA_BLOB', readFileSync(blob), {
  sentinelFuse: fuse,
  machoSegmentName: process.platform === 'darwin' && target === 'host' ? 'NODE_SEA' : undefined,
})

// 5. Лицензии рядом с исполняемым файлом: MIT программы (оригинал и перевод) и тексты
// лицензий сторонних компонентов, включая встроенную среду Node.js.
const notices = join(dist, 'legal', 'THIRD_PARTY_LICENSES.txt')
if (!existsSync(notices)) throw new Error('В сборке нет legal/THIRD_PARTY_LICENSES.txt.')
if (!readFileSync(notices, 'utf8').includes('Node.js is licensed for use as follows')) {
  throw new Error(
    'В THIRD_PARTY_LICENSES.txt нет лицензии Node.js: соберите интерфейс установленным Node.js, рядом с которым лежит файл LICENSE.',
  )
}
copyFileSync(notices, join(releaseDirectory, 'THIRD_PARTY_LICENSES.txt'))
copyFileSync(join(root, 'LICENSE'), join(releaseDirectory, 'LICENSE.txt'))
copyFileSync(join(root, 'LICENSE.ru.md'), join(releaseDirectory, 'LICENSE.ru.txt'))

const sha256 = createHash('sha256').update(readFileSync(output)).digest('hex')
const megabytes = (statSync(output).size / 1024 / 1024).toFixed(1)
console.log(
  `\nГотово: ${relative(root, output)} (${megabytes} МБ, Node.js ${process.versions.node})`,
)
console.log(`SHA-256: ${sha256}`)
console.log(
  'Рядом: LICENSE.txt, LICENSE.ru.txt, THIRD_PARTY_LICENSES.txt — передавайте вместе с программой.',
)
