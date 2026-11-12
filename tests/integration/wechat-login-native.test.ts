import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'

const execute = promisify(execFile)
const source = process.env.WECHAT_HOOK_SOURCE
const vcvars =
  'C:\\Program Files (x86)\\Microsoft Visual Studio\\2022\\BuildTools\\VC\\Auxiliary\\Build\\vcvars64.bat'

it.skipIf(process.platform !== 'win32' || !source || !existsSync(vcvars))(
  '生产原生读取、真实 HTTP 登录转换与发送前校验（自建映像，不发送微信消息）',
  async () => {
    const result = await execute(
      process.execPath,
      [path.resolve('scripts/test-wechat-hook-login.cjs'), '--source', source!],
      { timeout: 150_000, windowsHide: true, maxBuffer: 1024 * 1024 }
    )
    expect(result.stdout).toContain('"nativeFixtures":"passed"')
    expect(result.stdout).toContain('"httpTransitions":"passed"')
    expect(result.stdout).toContain('"sendGuards":"passed"')
  },
  160_000
)
