const { execFileSync } = require('node:child_process')
const { existsSync, mkdirSync, writeFileSync } = require('node:fs')
const path = require('node:path')

const root = path.resolve(__dirname, '..')
const index = process.argv.indexOf('--source')
const source = index >= 0 ? path.resolve(process.argv[index + 1]) : process.env.WECHAT_HOOK_SOURCE
if (
  process.platform !== 'win32' ||
  !source ||
  !existsSync(path.join(source, 'include/httplib.h'))
) {
  throw new Error('Windows native tests require --source <local WeChat-Hook source directory>')
}
const output = path.join(root, 'output/wechat-hook-validation/native')
const vcvars =
  'C:\\Program Files (x86)\\Microsoft Visual Studio\\2022\\BuildTools\\VC\\Auxiliary\\Build\\vcvars64.bat'
mkdirSync(output, { recursive: true })
const includes = [
  path.join(root, 'resources/wechat-hook/native'),
  path.join(source, 'include'),
  path.join(source, '3rdparty')
]
const sources = [
  path.join(root, 'tests/fixtures/wechat-login/native-test.cpp'),
  path.join(source, 'src/SendTextMsg.cpp'),
  path.join(source, 'src/SendImageMsg.cpp')
]
// These are file paths in a batch file, so reject characters expanded by cmd.exe.
for (const value of [vcvars, ...includes, ...sources]) {
  if (/["%\r\n!]/.test(value)) throw new Error('Unsupported build path characters')
}
const batch = path.join(output, 'build.cmd')
writeFileSync(
  batch,
  [
    '@echo off',
    `call "${vcvars}" >nul`,
    'if errorlevel 1 exit /b 1',
    `cl /nologo /std:c++20 /EHsc /MT /utf-8 ${includes.map((file) => `/I"${file}"`).join(' ')} ${sources.map((file) => `"${file}"`).join(' ')} /Fe:native-test.exe /link ws2_32.lib crypt32.lib`
  ].join('\r\n')
)
execFileSync('cmd.exe', ['/d', '/c', 'build.cmd'], {
  cwd: output,
  windowsHide: true,
  timeout: 120000,
  stdio: 'inherit'
})
const executable = path.join(output, 'native-test.exe')
execFileSync(executable, [], { windowsHide: true, timeout: 20000, stdio: 'inherit' })
const live = process.argv.indexOf('--live')
if (live >= 0) {
  execFileSync(executable, ['--live', process.argv[live + 1], process.argv[live + 2]], {
    windowsHide: true,
    timeout: 10000,
    stdio: 'inherit'
  })
}
