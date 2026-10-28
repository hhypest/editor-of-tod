import { describe, expect, it, vi } from 'vitest'
import { browserRuns, runBrowserTests } from '../test-e2e'

describe('isolated browser runner', () => {
  it('starts separate processes for both browsers with separate output folders and selection env', () => {
    const invoke = vi.fn<NonNullable<Parameters<typeof runBrowserTests>[1]>>(() => ({ status: 0 }))
    expect(runBrowserTests(['--list'], invoke)).toBe(0)
    expect(invoke).toHaveBeenCalledTimes(2)
    for (const [index, browser] of ['chromium', 'firefox'].entries()) {
      const [command, args, options] = invoke.mock.calls[index]!
      expect(command).toBe(process.execPath)
      expect(args).toEqual(
        expect.arrayContaining([
          `--project=${browser}`,
          `--output=test-results/${browser}`,
          '--list',
        ]),
      )
      expect(options.env.TOD_E2E_BROWSER).toBe(browser)
    }
  })

  it('honours a single browser selection and forwards filters unchanged', () => {
    expect(browserRuns(['--project', 'firefox', '--grep', 'A4 print'])).toEqual([
      { browser: 'firefox', args: ['--grep', 'A4 print'] },
    ])
    expect(browserRuns(['--project=chromium', '--project=chromium'])).toEqual([
      { browser: 'chromium', args: [] },
    ])
  })

  it('rejects unknown selections instead of silently skipping tests', () => {
    expect(() => browserRuns(['--project=unknown'])).toThrow('Выберите')
    expect(() => browserRuns(['--project'])).toThrow('Выберите')
  })

  it('retains a failing exit status while still exercising the other isolated browser', () => {
    const invoke = vi.fn().mockReturnValueOnce({ status: 1 }).mockReturnValueOnce({ status: 0 })
    expect(runBrowserTests([], invoke)).toBe(1)
    expect(invoke).toHaveBeenCalledTimes(2)
  })
})
