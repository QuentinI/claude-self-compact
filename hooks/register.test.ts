import { expect, mock, test, type TestBody } from 'claude-code/testing'
import type { On, SessionMessage } from 'claude-code'

const TOOL = 'mcp__self-compact__request_compaction'
const CANCEL = 'mcp__self-compact__cancel_compaction'
const summary: SessionMessage = { role: 'user', text: 'SUMMARY', toolUses: [] }

// Beneath the plugin: a store, HOME, a log that goes nowhere, and a compaction
// that answers one summary message.
const hello: SessionMessage = { role: 'user', text: 'hello', toolUses: [] }

// A store the test itself can change between calls (mock.store keeps a copy).
function liveStore(on: On, store: Record<string, unknown>) {
  on('store.get', ($, e) => ({ value: store[e.key] }))
  on('store.set', ($, e) => {
    store[e.key] = e.value
    return { value: undefined }
  })
}

function world(on: On, store: Record<string, unknown> = {}, live = false) {
  const seen = {
    instructions: [] as (string | undefined)[],
    logs: [] as { text: string; to: string }[],
    prompts: [] as { text: string; context?: readonly string[] }[],
    commands: [] as string[],
    appended: [] as string[],
    hold: false, // the plugin's own prompts wait (the session never goes idle)
    compacts: 0,
    clock: mock.clock(on, { now: 1_000_000_000 }),
  }
  if (live) liveStore(on, store)
  else mock.store(on, store)
  on('ui.log', ($, e) => {
    seen.logs.push(e)
    return { value: undefined }
  })
  on('ui.toast', () => ({ value: undefined }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('session.append', ($, e, next) => {
    seen.appended.push(JSON.stringify(e.message))
    return next(e)
  })
  on('prompt.submit', async ($, e) => {
    if (seen.hold && e.origin?.kind === 'plugin') await seen.clock.sleep(1e9)
    seen.prompts.push({ text: e.text, context: e.context })
    return { text: e.text, context: e.context }
  })
  on('command.run', ($, e) => {
    seen.commands.push(e.command)
    return { text: '' }
  })
  on('session.id', () => ({ value: 'S1' }))
  on('session.messages', () => ({ value: [summary] }))
  mock.env(on, { HOME: '/nonexistent-home' })
  on('session.compact', ($, e) => {
    seen.compacts++
    seen.instructions.push(e.instructions)
    return { messages: [summary], tokensBefore: 1000, tokensAfter: 100 }
  })
  return seen
}

test('carries text verbatim after the summary and adds alwaysInstructions', { options: { alwaysInstructions: 'keep the branch name' } }, async ($, on) => {
  const seen = world(on)
  const res = await $.session.compact({ trigger: 'manual', instructions: 'the plan', messages: [hello] })
  expect(seen.instructions).toEqual(['the plan\n\nkeep the branch name'])
  expect(res.messages?.length).toBe(1)
})

test('alwaysCarry lands after every compaction', { options: { alwaysCarry: 'Re-read HANDOFF.md' } }, async ($, on) => {
  world(on)
  const res = await $.session.compact({ trigger: 'auto', messages: [hello] })
  if (!res.messages) throw new Error('skipped')
  expect(res.messages.length).toBe(2)
  expect(res.messages[1]?.text).toContain('Re-read HANDOFF.md')
  expect(res.messages[1]?.text).toContain('<self-compact-carry>')
})

test('a second request in the same turn replaces the first', async ($, on) => {
  world(on)
  const first = await $.tool.call({ tool: TOOL, carry: 'x' } as never)
  const second = await $.tool.call({ tool: TOOL } as never)
  expect(JSON.stringify(first)).toContain('Compaction scheduled')
  expect(JSON.stringify(second)).toContain('request replaced')
})

test('a replacement is not refused by minIntervalMinutes', { options: { minIntervalMinutes: 10 } }, async ($, on) => {
  const store: Record<string, unknown> = {}
  world(on, store, true)
  await $.tool.call({ tool: TOOL } as never)
  store['session:S1'] = { lastAt: 1_000_000_000, count: 1 }
  const res = await $.tool.call({ tool: TOOL, carry: 'y' } as never)
  expect(JSON.stringify(res)).toContain('request replaced')
})

test('cancel_compaction drops the request', async ($, on) => {
  world(on)
  const none = await $.tool.call({ tool: CANCEL } as never)
  await $.tool.call({ tool: TOOL } as never)
  const cancelled = await $.tool.call({ tool: CANCEL } as never)
  const again = await $.tool.call({ tool: TOOL } as never)
  expect(JSON.stringify(none)).toContain('Nothing to cancel')
  expect(JSON.stringify(cancelled)).toContain('Compaction cancelled')
  expect(JSON.stringify(again)).toContain('Compaction scheduled')
})

test('the tool refuses within minIntervalMinutes of the last self-compaction', { options: { minIntervalMinutes: 10 } }, async ($, on) => {
  world(on, { 'session:S1': { lastAt: 1_000_000_000 - 60_000, count: 1 } })
  const res = await $.tool.call({ tool: TOOL } as never)
  expect(JSON.stringify(res)).toContain('Not scheduled')
})

test("another session's compaction does not count", async ($, on) => {
  world(on, { 'session:S2': { lastAt: 1_000_000_000 - 60_000, count: 1 } })
  const res = await $.tool.call({ tool: TOOL } as never)
  expect(JSON.stringify(res)).toContain('Compaction scheduled')
})

test('routine steps stay off the transcript', async ($, on) => {
  const seen = world(on)
  await $.tool.call({ tool: TOOL } as never)
  await $.session.compact({ trigger: 'manual', messages: [hello] })
  expect(seen.logs.length).toBe(2)
  expect(seen.logs.every(l => l.to === 'debug')).toBe(true)
})

// The desktop app sends a message typed mid-turn right after the turn ends: its
// turn (T2) starts before the compaction requested in T1 runs (seen live).
const ended = (turnId: string) =>
  ({ turnId, reason: 'answer', isAborted: false, answer: '', durationMs: 1 }) as const

async function queuedTurn($: Parameters<TestBody>[0], seen: ReturnType<typeof world>) {
  await $.turn.start({ turnId: 'T1', text: 'work' })
  await $.tool.call({ tool: TOOL, carry: 'c', resume: 'go on' } as never)
  await $.turn.complete(ended('T1'))
  await $.prompt.submit({ text: 'queued-test' } as never)
  await $.turn.start({ turnId: 'T2', text: 'queued-test' })
  await seen.clock.settle()
}

test('a turn that starts first keeps the request pending and cancellable', async ($, on) => {
  const seen = world(on)
  await queuedTurn($, seen)
  expect(seen.compacts).toBe(0)
  expect(JSON.stringify(seen.prompts[0]?.context ?? [])).toContain('has not run yet')
  const cancelled = await $.tool.call({ tool: CANCEL } as never)
  expect(JSON.stringify(cancelled)).toContain('Compaction cancelled')
  await $.turn.complete(ended('T2'))
  await seen.clock.advance(200_000)
  expect(seen.compacts).toBe(0)
  expect(seen.commands).toEqual([])
})

test('a deferred request runs when the other turn ends, then resumes', async ($, on) => {
  const seen = world(on)
  await queuedTurn($, seen)
  expect(seen.compacts).toBe(0)
  await $.turn.complete(ended('T2'))
  await seen.clock.settle()
  expect(seen.compacts).toBe(1)
  expect(seen.prompts.map(p => p.text)).toEqual(['queued-test', expect.stringContaining('self-compact-carry')])
})

// A subagent message queued during the compaction starts the next turn; the
// resume prompt waits for an idle session (seen live in the desktop app).
test('the resume text is carried and a waiting resume prompt blocks nothing', async ($, on) => {
  const seen = world(on)
  seen.hold = true
  await $.turn.start({ turnId: 'T1', text: 'work' })
  await $.tool.call({ tool: TOOL, carry: 'ids', resume: 'add the row' } as never)
  await $.turn.complete(ended('T1'))
  await seen.clock.settle()
  expect(seen.compacts).toBe(1)
  expect(seen.appended.join()).toContain('add the row')
  expect(seen.prompts).toEqual([])
  await $.turn.start({ turnId: 'T2', text: 'agent message' })
  await seen.clock.advance(11 * 60_000)
  const again = await $.tool.call({ tool: TOOL } as never)
  expect(JSON.stringify(again)).toContain('Compaction scheduled')
})

test('an unknown field is named in the answer, and the request still scheduled', async ($, on) => {
  const seen = world(on)
  const res = await $.tool.call({ tool: TOOL, carry: 'c', resume_prompt: 'go on' } as never)
  expect(JSON.stringify(res)).toContain('Compaction scheduled')
  expect(JSON.stringify(res)).toContain('ignored unknown field resume_prompt')
  expect(JSON.stringify(res)).toContain('no resume')
  expect(seen.logs.some(l => l.text.includes('ignored resume_prompt'))).toBe(true)
})

// The step itself lives in the carry alone; the queued prompt only points at it.
test('the resume step is delivered once, in the carry', async ($, on) => {
  const seen = world(on)
  await $.turn.start({ turnId: 'T1', text: 'work' })
  await $.tool.call({ tool: TOOL, resume: 'add the row' } as never)
  await $.turn.complete(ended('T1'))
  await seen.clock.settle()
  expect(seen.prompts.length).toBe(1)
  expect(seen.prompts[0]?.text).not.toContain('add the row')
})

test('maxCompactions refuses once the session used them', { options: { maxCompactions: 2, minIntervalMinutes: 0 } }, async ($, on) => {
  world(on, { 'session:S1': { count: 2 } })
  const res = await $.tool.call({ tool: TOOL } as never)
  expect(JSON.stringify(res)).toContain('2 self-compactions in this session already (max 2)')
})

test('a per-session limit overrides the option', { options: { maxCompactions: 0 } }, async ($, on) => {
  world(on, { 'session:S1': { count: 1, limits: { max: 1 } } })
  const res = await $.tool.call({ tool: TOOL } as never)
  expect(JSON.stringify(res)).toContain('(max 1)')
})

test('resume is withheld after maxResumes in a row, and a prompt from the person resets it', { options: { maxResumes: 1, minIntervalMinutes: 0 } }, async ($, on) => {
  const store: Record<string, unknown> = { 'session:S1': { resumes: 1 } }
  world(on, store, true)
  const held = await $.tool.call({ tool: TOOL, resume: 'go on' } as never)
  expect(JSON.stringify(held)).toContain('resume withheld')
  await $.tool.call({ tool: CANCEL } as never)
  await $.prompt.submit({ text: 'hi', origin: { kind: 'composer' } } as never)
  expect((store['session:S1'] as { resumes: number }).resumes).toBe(0)
  const ok = await $.tool.call({ tool: TOOL, resume: 'go on' } as never)
  expect(JSON.stringify(ok)).toContain('resume 5 chars')
})

test('maxResumes 0 turns resume off', { options: { maxResumes: 0 } }, async ($, on) => {
  world(on)
  const res = await $.tool.call({ tool: TOOL, resume: 'go on' } as never)
  expect(JSON.stringify(res)).toContain('resume is off')
})

test('/self-compact shows the limits; a plugin cannot change them', { options: { maxResumes: 3 } }, async ($, on) => {
  world(on)
  const shown = await $.command.run({ command: 'self-compact' } as never)
  expect(shown.text).toContain('resumes: 3 in a row')
  const refused = await $.command.run({ command: 'self-compact', args: 'max 100' } as never)
  expect(refused.text).toContain('only you can change the limits')
})

test('a dropped request is reported in the transcript', async ($, on) => {
  const seen = world(on)
  await $.turn.start({ turnId: 'T1', text: 'work' })
  await $.tool.call({ tool: TOOL } as never)
  await $.turn.complete({ ...ended('T1'), reason: 'error' } as never)
  expect(seen.logs.some(l => l.to === 'transcript' && l.text.includes('dropped'))).toBe(true)
})

test('the person sets and resets per-session limits with /self-compact', { options: { minIntervalMinutes: 10 } }, async ($, on) => {
  const store: Record<string, unknown> = {}
  world(on, store, true)
  const run = (args: string) =>
    $.command.run({ command: 'self-compact', args, origin: { kind: 'composer' } } as never)
  const set = await run('interval 0 max 1 resumes 0')
  expect(set.text).toContain('interval: 0 min between self-compactions (this session)')
  expect(set.text).toContain('max: 1 self-compactions (this session)')
  expect(set.text).toContain('resumes: off (this session)')
  const bad = await run('max -1')
  expect(bad.text).toContain('max needs a number of 0 or more')
  const reset = await run('reset')
  expect(reset.text).toContain('interval: 10 min between self-compactions\n')
})
