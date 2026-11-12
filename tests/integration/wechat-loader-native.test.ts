import { execFile } from 'node:child_process'
import { copyFileSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'

const execute = promisify(execFile)
const vcvars =
  'C:\\Program Files (x86)\\Microsoft Visual Studio\\2022\\BuildTools\\VC\\Auxiliary\\Build\\vcvars64.bat'

it.skipIf(process.platform !== 'win32' || !existsSync(vcvars))(
  '真实配套启动器对重命名模块误报失败，对 version.dll 成功（仅操作自建测试进程）',
  async () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'tm-loader-space-'))
    const fixture = path.resolve('tests/fixtures/wechat-loader')
    try {
      writeFileSync(
        path.join(directory, 'build.cmd'),
        [
          '@echo off',
          `call "${vcvars}" >nul`,
          'if errorlevel 1 exit /b 1',
          `cl /nologo /EHsc /MT "${path.join(fixture, 'target.cpp')}" /Fe:Weixin.exe`,
          'if errorlevel 1 exit /b 1',
          `cl /nologo /LD /MT "${path.join(fixture, 'module.cpp')}" /Fe:Weixin.dll`
        ].join('\r\n')
      )
      await execute('cmd.exe', ['/d', '/c', 'build.cmd'], {
        cwd: directory,
        windowsHide: true,
        timeout: 30_000
      })
      const renamed = path.join(directory, 'version-4.1.15.56.dll')
      const expected = path.join(directory, 'version.dll')
      copyFileSync(path.join(directory, 'Weixin.dll'), renamed)
      copyFileSync(path.join(directory, 'Weixin.dll'), expected)
      const loader = path.resolve('resources/wechat-hook/wxinject.exe')
      const target = path.join(directory, 'Weixin.exe')
      await expect(
        execute(loader, [target, renamed], { cwd: directory, windowsHide: true, timeout: 10_000 })
      ).rejects.toMatchObject({
        code: 7,
        stdout: expect.stringContaining('LoadLibraryW returned 0x')
      })
      const success = await execute(loader, [target, expected], {
        cwd: directory,
        windowsHide: true,
        timeout: 10_000
      })
      expect(success.stdout).toContain('hook dll injected OK')
    } finally {
      // Test targets exit themselves; never terminate a user's WeChat process.
      await new Promise((resolve) => setTimeout(resolve, 3500))
      rmSync(directory, { recursive: true, force: true })
    }
  },
  45_000
)
