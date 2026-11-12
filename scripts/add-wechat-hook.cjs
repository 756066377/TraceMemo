#!/usr/bin/env node
/**
 * 把一个 WeChat-Hook 的 version.dll 放进 resources/wechat-hook，并写进 manifest，
 * 使下一次 `pnpm build:win` 产出的安装包自带该组件。
 *
 * 用法：
 *   node scripts/add-wechat-hook.cjs <dll 路径> --version 4.1.15.56
 *   node scripts/add-wechat-hook.cjs <dll 路径> --version 4.1.10.27 --version 4.1.15.56
 *   node scripts/add-wechat-hook.cjs <dll 路径> --all        # 声明适用任意版本（仍需用户确认）
 *
 * 文件命名：version-<版本>.dll；--all 时为 version.dll。
 * 多次指向同一版本会覆盖旧文件并更新 sha256。
 */
const { createHash } = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.resolve(__dirname, '..')
const HOOK_DIR = path.join(ROOT, 'resources', 'wechat-hook')
const MANIFEST = path.join(HOOK_DIR, 'manifest.json')

function fail(message) {
  console.error(`[add:wechat-hook] ${message}`)
  process.exit(1)
}

function readPeMachine(filePath) {
  const buffer = fs.readFileSync(filePath)
  if (buffer.length < 0x40 || buffer.readUInt16LE(0) !== 0x5a4d) return 'unknown'
  const peOffset = buffer.readUInt32LE(0x3c)
  if (peOffset + 6 > buffer.length) return 'unknown'
  if (buffer.readUInt32LE(peOffset) !== 0x00004550) return 'unknown'
  const machine = buffer.readUInt16LE(peOffset + 4)
  if (machine === 0x8664) return 'x64'
  if (machine === 0x014c) return 'x86'
  return 'unknown'
}

const argv = process.argv.slice(2)
const source = argv.find((arg) => !arg.startsWith('--'))
const versions = []
let allVersions = false
let origin = ''
for (let i = 0; i < argv.length; i += 1) {
  if (argv[i] === '--version' && argv[i + 1]) versions.push(argv[i + 1].trim())
  if (argv[i] === '--all') allVersions = true
  if (argv[i] === '--source' && argv[i + 1]) origin = argv[i + 1].trim()
}

if (!source) {
  fail('用法：node scripts/add-wechat-hook.cjs <version.dll 路径> --version 4.1.15.56')
}
if (!fs.existsSync(source)) fail(`找不到文件：${source}`)
if (path.extname(source).toLowerCase() !== '.dll') fail('只接受 .dll 文件')
if (!allVersions && versions.length === 0) {
  fail('至少给一个 --version（微信版本号），或用 --all 声明不限定版本')
}

const machine = readPeMachine(source)
if (machine !== 'x64') fail(`PE Machine 是 ${machine}，微信 4.x 只接受 x64`)

fs.mkdirSync(HOOK_DIR, { recursive: true })

const file = allVersions ? 'version.dll' : `version-${versions[0]}.dll`
const target = path.join(HOOK_DIR, file)
if (path.resolve(source) !== path.resolve(target)) {
  fs.copyFileSync(source, target)
}

const sha256 = createHash('sha256').update(fs.readFileSync(target)).digest('hex')

let manifest = { schema: 1, components: [] }
if (fs.existsSync(MANIFEST)) {
  try {
    const parsed = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'))
    if (parsed && parsed.schema === 1 && Array.isArray(parsed.components)) manifest = parsed
  } catch {
    // 损坏的 manifest 直接重建，不让一次手误阻断打包。
  }
}

const wechatVersions = allVersions ? ['*'] : Array.from(new Set(versions)).sort()
manifest.components = manifest.components.filter((component) => component.file !== file)
manifest.components.push({
  file,
  wechatVersions,
  sha256,
  ...(origin ? { source: origin } : {})
})
manifest.components.sort((a, b) => String(a.file).localeCompare(String(b.file)))

const tmp = `${MANIFEST}.tmp`
fs.writeFileSync(tmp, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
fs.renameSync(tmp, MANIFEST)

console.log(`[add:wechat-hook] 已写入 ${path.relative(ROOT, target)}`)
console.log(`[add:wechat-hook] 适用版本 ${wechatVersions.join(',')}｜sha256=${sha256}`)
console.log('[add:wechat-hook] 下一次 pnpm build:win 会把该组件打进安装包')
