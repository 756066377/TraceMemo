import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: {
    getAppPath: () => '/fixture/app',
    getPath: () => '/tmp/tracememo-test-user-data',
    isPackaged: false
  }
}))

import {
  WindowsHookHttpError,
  classifyWechatSendError,
  parseListeningPorts,
  splitWechatText
} from '../../src/main/services/personal-wechat-send-service'

describe('本机端口解析', () => {
  it('只保留回环/全网的 LISTENING 端口，忽略外部地址与已建立连接', () => {
    const sample = [
      '  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       1234',
      '  TCP    127.0.0.1:9999         0.0.0.0:0              LISTENING       5678',
      '  TCP    [::]:8000              [::]:0                 LISTENING       9012',
      '  TCP    192.168.1.5:445        0.0.0.0:0              LISTENING       1111',
      '  TCP    127.0.0.1:5000         127.0.0.1:6000         ESTABLISHED     2222',
      '  UDP    0.0.0.0:500             *:*                                    3333'
    ].join('\r\n')
    expect(parseListeningPorts(sample)).toEqual(['135', '9999', '8000'])
  })

  it('空输出或异常端口不会抛错', () => {
    expect(parseListeningPorts('')).toEqual([])
    expect(
      parseListeningPorts(
        '  TCP    127.0.0.1:99999        0.0.0.0:0              LISTENING       1'
      )
    ).toEqual([])
  })
})

describe('长文本分段', () => {
  it('短文本不拆分', () => {
    expect(splitWechatText('我九点到')).toEqual(['我九点到'])
    expect(splitWechatText('   ')).toEqual([])
  })

  it('长文本按句子切分，每段不超过上限', () => {
    const sentence = '今天下午开会到六点，散会之后我去楼下买杯咖啡，然后再过去找你。'
    const text = sentence.repeat(80)
    const chunks = splitWechatText(text, 200)
    expect(chunks.length).toBeGreaterThan(1)
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(200)
    }
    // 切分不能吞字：拼回去的可见字符数量必须一致。
    const normalize = (value: string): string => value.replace(/\s+/g, '')
    expect(normalize(chunks.join(''))).toBe(normalize(text))
  })

  it('优先在段落换行处切分', () => {
    const first = 'a'.repeat(150)
    const second = 'b'.repeat(150)
    const chunks = splitWechatText(`${first}\n${second}`, 200)
    expect(chunks[0]).toBe(first)
    expect(chunks[1]).toBe(second)
  })

  it('没有标点时硬切，不产生空段', () => {
    const chunks = splitWechatText('x'.repeat(1000), 300)
    expect(chunks.every((chunk) => chunk.length > 0)).toBe(true)
    expect(chunks.join('')).toHaveLength(1000)
  })
})

describe('发送错误分类', () => {
  it('HTTP 5xx 归为 hook_error', () => {
    const classified = classifyWechatSendError(new WindowsHookHttpError(503, 'busy'))
    expect(classified.code).toBe('hook_error')
    expect(classified.message).toContain('503')
  })

  it('HTTP 429 归为限流', () => {
    expect(classifyWechatSendError(new WindowsHookHttpError(429, 'slow down')).code).toBe(
      'rate_limited'
    )
  })

  it('超时明确提示「可能已经发出」', () => {
    const abort = new DOMException('aborted', 'AbortError')
    const classified = classifyWechatSendError(abort)
    expect(classified.code).toBe('timeout')
    expect(classified.message).toContain('可能已经发出')
  })

  it('连接失败归为网络问题', () => {
    const classified = classifyWechatSendError(
      new Error('fetch failed: connect ECONNREFUSED 127.0.0.1:12345')
    )
    expect(classified.code).toBe('network')
  })

  it('空响应归为 hook 异常', () => {
    expect(classifyWechatSendError(new Error('Windows 微信发送能力返回空响应')).code).toBe(
      'hook_error'
    )
  })
})
