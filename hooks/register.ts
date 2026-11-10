import type { EngineInterface as Engine, Register, SessionMessage } from 'claude-code'

// The model calls request_compaction mid-turn; the tool only records the request,
// because a compaction cannot run while a turn runs. When the main loop's turn
// completes, the compaction runs (the same path as a typed /compact: the visible
// history stays, a summary replaces the context), then an optional resume prompt
// starts the next turn.
//
// What reaches the agent after a compaction:
//   instructions  what the summarizer must keep (the text after /compact)
//   carry         text placed verbatim after the summary (never summarized)
//   resume        the next step, placed after the summary with the carry; a
//                 fixed prompt pointing at it starts the next turn
// The options alwaysInstructions / alwaysCarry apply to EVERY compaction of the
// main conversation (a typed /compact and auto-compaction too).
//
// Calling request_compaction again in the same turn replaces the request;
// cancel_compaction drops it. Both are too late once the compaction runs.
//
// A prompt can start a turn before the compaction does (the desktop app sends a
// message typed mid-turn right after the turn ends). The request then stays
// pending, the model is told so beside that prompt, and the compaction runs when
// that turn ends.
//
// The resume prompt waits for an idle session, behind whatever was queued during
// the compaction (subagent messages, task notifications), and can be the second
// turn or later. So the next step itself lives only in the carry, where the model
// reads it before any next message, and the queued prompt merely points at it:
// the step is never delivered twice.
//
// Guards: one request at a time; per session, at least `interval` minutes between
// self-compactions, at most `max` of them, and at most `resumes` resume prompts
// in a row without a prompt from the person (each limit an option, overridable
// per session with /self-compact). Session counters live in $.store, so a reload
// does not reset them. An aborted turn (the person pressed Stop) drops the
// request. Every decision goes to the debug log and to
// ~/.claude/self-compact/<session id>.log; only failures show in the transcript.

const TOOL = 'request_compaction'
const FULL = 'mcp__self-compact__request_compaction'
const CANCEL = 'cancel_compaction'
const CANCEL_FULL = 'mcp__self-compact__cancel_compaction'
const COMMAND = 'self-compact'
const RETRIES = 120
const RETRY_MS = 1000
const MAX_TEXT = 8000
const LOG_KEEP = 400
const SESSION_PREFIX = 'session:'
const SESSION_KEEP_MS = 7 * 24 * 3600_000
const FIELDS = ['instructions', 'carry', 'resume']
// Keys a tool.call input carries beside the tool's own arguments. Only used to
// keep them out of the "ignored fields" note, so a key missing here is harmless.
const ENVELOPE = ['tool', 'consent', 'tool_use_id', 'agentId', 'requestMeta']
// Prompt origins that are the person's own message: they reset the resume count.
const HUMAN = ['composer', 'bridge', 'sdk']

type Job = { instructions?: string; carry?: string; resume?: string; carried?: boolean }
let pending: Job | undefined   // requested, not started: replace and cancel act on it
let running: Job | undefined   // the compaction has started
let scheduled: Job | undefined // a turn.complete callback is working on it
let openTurn: string | undefined // the main loop's running turn (subagents raise no turn.start)

// interval in minutes (0: none); max self-compactions (0: no limit); resumes in a
// row without a prompt from the person (0: resume is off).
type Limits = { interval: number; max: number; resumes: number }
type Session = { at: number; lastAt: number; count: number; resumes: number; limits: Partial<Limits> }
const LIMIT_WORDS = { interval: 'interval', max: 'max', resumes: 'resumes' } as const

const PENDING_NOTE =
  'self-compact: the compaction you requested with request_compaction has not run yet. It ' +
  'runs when this turn ends, with the instructions, carry and resume you gave before this ' +
  'prompt. If they no longer fit, call request_compaction again to replace them, or ' +
  'cancel_compaction to drop it.'

const RESUME_PROMPT =
  'Continue from the next step carried after the compaction summary (the <self-compact-carry> ' +
  'block). If you already did it, say so in one line.'

const str = (v: unknown, max: number) =>
  typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined

const join = (...parts: (string | undefined)[]) =>
  parts.filter(p => p !== undefined && p !== '').join('\n\n') || undefined

const carryMessage = (text: string): SessionMessage => ({
  role: 'user',
  text:
    '<self-compact-carry>\nCarried verbatim across the compaction above by the self-compact ' +
    'plugin (not summarized; written before compacting):\n\n' + text + '\n</self-compact-carry>',
  toolUses: [],
})

// One session's log file, its lines kept in memory so a write never has to read
// first; writes are chained so two log calls never interleave.
let logFile: { path: string; lines: string[] } | undefined
let logChain: Promise<void> = Promise.resolve()

async function writeLog($: Engine, line: string) {
  const home = await $.env.get('HOME')
  if (!home) return
  const path = `${home}/.claude/self-compact/${await $.session.id()}.log`
  if (logFile?.path !== path) {
    const old = (await $.fs.read(path).catch(() => '')).split('\n').filter(Boolean)
    logFile = { path, lines: old }
  }
  logFile.lines = [...logFile.lines, line].slice(-LOG_KEEP)
  await $.fs.write(path, logFile.lines.join('\n') + '\n')
}

async function log($: Engine, line: string, loud = false) {
  $.ui.log(`self-compact: ${line}`, { to: loud ? 'transcript' : 'debug' })
  const stamp = new Date(await $.clock.now()).toISOString()
  logChain = logChain.then(() => writeLog($, `${stamp} ${line}`)).catch(() => {})
  return logChain
}

async function getSession($: Engine): Promise<Session> {
  const stored = (await $.store.get(SESSION_PREFIX + (await $.session.id()))) as Partial<Session> | undefined
  return { at: 0, lastAt: 0, count: 0, resumes: 0, limits: {}, ...stored }
}

async function putSession($: Engine, s: Session) {
  await $.store.set(SESSION_PREFIX + (await $.session.id()), { ...s, at: await $.clock.now() })
}

async function pruneSessions($: Engine) {
  const now = await $.clock.now()
  for (const key of await $.store.keys()) {
    if (!key.startsWith(SESSION_PREFIX)) continue
    const s = (await $.store.get(key)) as Partial<Session> | undefined
    if (now - (s?.at ?? 0) > SESSION_KEEP_MS) await $.store.delete(key)
  }
}

// What the job carries after the summary: its carry, then its next step.
const jobCarry = (job: Job) =>
  join(
    job.carry,
    job.resume &&
      'Next step (start here; a short prompt pointing at this block follows the compaction, ' +
        'but a message queued during the compaction can arrive first: then act on this ' +
        'together with that message, once):\n' + job.resume,
  )

// After a self-compaction: record it, carry the text if the session.compact hook
// did not, and queue the resume prompt.
async function finish($: Engine, job: Job, how: string) {
  const s = await getSession($)
  await putSession($, {
    ...s,
    lastAt: await $.clock.now(),
    count: s.count + 1,
    resumes: s.resumes + (job.resume ? 1 : 0),
  })
  await log($, `${how}: done (self-compaction ${s.count + 1} in this session)`)
  const carry = jobCarry(job)
  if (carry && !job.carried) {
    await $.session.append({ message: { type: 'user', content: [{ type: 'text', text: carryMessage(carry).text }] } })
    await log($, 'carry appended after the compaction (fallback)')
  }
  $.ui.toast('Self-compacted')
  if (job.resume) {
    // Not awaited: it resolves only when its turn starts, which can be much later.
    await log($, 'resume prompt queued')
    void $.prompt
      .submit({ text: RESUME_PROMPT })
      .then(() => log($, 'resume prompt started its turn'))
      .catch(err => log($, `resume prompt failed: ${String(err).slice(0, 300)}`, true))
  }
}

// Whether `job` must not run now: cancelled or replaced, or another turn started
// first (then it stays pending and that turn's turn.complete runs it).
async function superseded($: Engine, job: Job) {
  if (pending !== job) return true
  if (openTurn === undefined) return false
  await log($, `deferred: turn ${openTurn} started first; compacting when it ends`)
  return true
}

// Compacts for `job` unless superseded.
async function compact($: Engine, job: Job, turnId: string) {
  await log($, `turn ${turnId} complete; compacting`)
  let lastErr = ''
  let headless = false
  for (let i = 0; i < RETRIES && !headless; i++) {
    if (await superseded($, job)) return
    running = job
    try {
      const res = await $.session.compact(job.instructions ? { instructions: job.instructions } : {})
      pending = undefined
      if (res.skip !== undefined) {
        await log($, `skipped by a hook: ${res.skip}`)
        $.ui.toast(`Self-compaction skipped: ${res.skip}`)
        return
      }
      await finish($, job, `session.compact after ${i} retries`)
      return
    } catch (err) {
      running = undefined
      const msg = String(err).slice(0, 300)
      // SDK-hosted sessions (Claude Desktop) cannot compact between turns yet:
      // there a /compact command is the way, so stop retrying at once.
      if (msg.includes('headless')) headless = true
      else if (msg !== lastErr) await log($, `session.compact try ${i} rejected: ${msg}`)
      lastErr = msg
      if (!headless) await $.clock.sleep(RETRY_MS)
    }
  }
  if (await superseded($, job)) return
  // Headless (or still busy after the retries): run /compact as if the person
  // typed it ($.prompt.submit refuses text starting with "/"); the engine
  // queues it until the session is idle.
  running = job
  pending = undefined
  try {
    await $.command.run({ command: 'compact', args: job.instructions ?? '' })
    await finish($, job, `/compact via command.run (${headless ? 'headless host' : 'retries exhausted'})`)
  } catch (err) {
    await log($, `/compact via command.run rejected: ${String(err).slice(0, 300)}`, true)
    $.ui.toast('Self-compaction failed; see ~/.claude/self-compact/')
  }
}

// `/self-compact [interval <min>] [max <n>] [resumes <n>] | reset`: the words it
// takes, or why not.
function parseLimits(args: string): Partial<Limits> | 'reset' | { error: string } {
  const words = args.trim().split(/\s+/).filter(Boolean)
  if (words.length === 1 && words[0] === 'reset') return 'reset'
  const out: Partial<Limits> = {}
  for (let i = 0; i < words.length; i += 2) {
    const key = words[i] as keyof Limits
    const value = Number(words[i + 1])
    if (!(key in LIMIT_WORDS)) return { error: `unknown limit "${words[i]}"` }
    if (!Number.isFinite(value) || value < 0) return { error: `${key} needs a number of 0 or more` }
    out[key] = value
  }
  return out
}

export const register: Register = (on, options) => {
  const alwaysInstructions = str(options.alwaysInstructions, MAX_TEXT)
  const alwaysCarry = str(options.alwaysCarry, MAX_TEXT)
  const num = (v: unknown, dflt: number) => Math.max(0, Number(v ?? dflt) || 0)
  const defaults: Limits = {
    interval: num(options.minIntervalMinutes, 10),
    max: num(options.maxCompactions, 0),
    resumes: num(options.maxResumes, 3),
  }
  const limitsOf = (s: Session): Limits => ({ ...defaults, ...s.limits })

  const describe = (s: Session) => {
    const l = limitsOf(s)
    const mark = (k: keyof Limits) => (k in s.limits ? ' (this session)' : '')
    return [
      `interval: ${l.interval} min between self-compactions${mark('interval')}`,
      `max: ${l.max ? `${l.max} self-compactions` : 'no limit'}${mark('max')}, ${s.count} so far`,
      `resumes: ${l.resumes ? `${l.resumes} in a row` : 'off'}${mark('resumes')}, ` +
        `${s.resumes} since your last prompt`,
    ].join('\n')
  }

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await pruneSessions($).catch(() => {})
    await $.tool.register({
      name: TOOL,
      description:
        'Compact your own context (the same as the user typing /compact; the visible chat ' +
        'history is kept). The compaction runs right after your current turn ends, so call ' +
        'this as the last action of a turn and then end the turn with one short line. ' +
        'Before calling, make sure durable state lives in files. `instructions`: what the ' +
        'summary must keep. `carry`: text you need verbatim afterwards (ids, paths, the exact ' +
        'next step); it is placed after the summary unchanged. `resume`: optional next step ' +
        'to start on right after the compaction (omit to wait for the user); it is carried ' +
        'after the summary and a prompt pointing at it starts your next turn. Calling it ' +
        'again in the same turn replaces the request (fields left out are dropped); ' +
        'cancel_compaction cancels it (both work until the compaction starts). The session ' +
        'limits the user set (interval, count, resumes in a row) can refuse a request or ' +
        'withhold `resume`; the answer says so.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          instructions: { type: 'string', description: 'What the summary must keep or stress.' },
          carry: { type: 'string', description: 'Text placed verbatim after the summary.' },
          resume: { type: 'string', description: 'The next step to start on after the compaction.' },
        },
      },
      isDeferred: false,
    })
    await $.tool.register({
      name: CANCEL,
      description: 'Cancel the compaction requested with request_compaction (until it starts).',
      inputSchema: { type: 'object', properties: {} },
    })
    await $.command.register({
      name: COMMAND,
      description: "Show or set this session's self-compact limits",
      argumentHint: '[interval <min>] [max <n>] [resumes <n>] | reset',
      immediate: true,
    })
    return started
  })

  // The spec's isDeferred is not always honoured in SDK hosts: pin the tool in front.
  on('tool.describe', { tool: FULL }, async ($, e, next) => ({ ...(await next(e)), isDeferred: false }))
    .catch(($, e, next) => next(e))

  on('tool.call', { tool: FULL }, async ($, e) => {
    const input = e as unknown as Record<string, unknown>
    if (running) return { result: 'Not changed: the compaction is already running.' }
    const replaced = pending !== undefined
    const s = await getSession($)
    const limits = limitsOf(s)
    if (!replaced) {
      const since = (await $.clock.now()) - s.lastAt
      let why: string | undefined
      if (limits.max && s.count >= limits.max)
        why = `refused: ${s.count} self-compactions in this session already (max ${limits.max})`
      else if (since < limits.interval * 60_000)
        why = `refused: last self-compaction ${Math.round(since / 1000)} s ago (min ${limits.interval * 60} s)`
      if (why) {
        await log($, why)
        return { result: `Not scheduled (${why}). The user can change the limit with /${COMMAND}.` }
      }
    }
    let resume = str(input.resume, MAX_TEXT)
    let withheld: string | undefined
    if (resume && s.resumes >= limits.resumes) {
      withheld = limits.resumes
        ? `${s.resumes} resumes in a row without a prompt from the user (limit ${limits.resumes})`
        : 'resume is off for this session'
      resume = undefined
    }
    pending = {
      instructions: str(input.instructions, MAX_TEXT),
      carry: str(input.carry, MAX_TEXT),
      resume,
    }
    // Scheduled anyway: the answer names what was ignored, and lists what was kept.
    const ignored = Object.keys(input).filter(k => !FIELDS.includes(k) && !ENVELOPE.includes(k))
    const extras = [pending.carry && 'carry', pending.resume && 'resume'].filter(Boolean).join(', ')
    await log(
      $,
      `${replaced ? 'replaced' : 'scheduled'} for end of turn${extras ? ` (+ ${extras})` : ''}` +
        `${withheld ? `; resume withheld: ${withheld}` : ''}${ignored.length ? `; ignored ${ignored.join(', ')}` : ''}`,
    )
    const got = [
      pending.instructions && `instructions ${pending.instructions.length} chars`,
      pending.carry && `carry ${pending.carry.length} chars`,
      pending.resume
        ? `resume ${pending.resume.length} chars`
        : withheld
          ? `resume withheld (${withheld}): after it the session waits for the user`
          : 'no resume: after it the session waits for the user',
      ignored.length && `ignored unknown field ${ignored.join(', ')} (the fields are ${FIELDS.join(', ')})`,
    ].filter(Boolean).join('; ')
    return {
      result:
        `Compaction ${replaced ? 'request replaced' : 'scheduled'} (${got}): it runs when this turn ends. ` +
        'End your turn now with one short line; do not start new work in this turn' +
        `${ignored.length ? ', unless you call request_compaction again to fix the fields' : ''}.`,
    }
  }).catch(() => ({ result: 'self-compact failed internally; nothing was scheduled.' }))

  // The generated tool types list only the tools connected at the last load.
  on('tool.call', { tool: CANCEL_FULL as typeof FULL }, async ($, e) => {
    if (running) return { result: 'Too late: the compaction is already running.' }
    if (!pending) return { result: 'Nothing to cancel: no compaction is scheduled.' }
    pending = undefined
    await log($, 'cancelled')
    return { result: 'Compaction cancelled.' }
  }).catch(() => ({ result: 'self-compact failed internally; the request may still be scheduled.' }))

  // Only the person's own command changes the limits: the model must not lift
  // the limits that bound it.
  on('command.run', { command: COMMAND }, async ($, e) => {
    const s = await getSession($)
    const args = e.args ?? ''
    if (!args.trim()) return { text: `self-compact limits for this session:\n${describe(s)}` }
    if (!e.origin || !HUMAN.includes(e.origin.kind)) return { text: `self-compact: only you can change the limits.` }
    const parsed = parseLimits(args)
    if (typeof parsed === 'object' && 'error' in parsed)
      return { text: `self-compact: ${parsed.error}. Usage: /${COMMAND} [interval <min>] [max <n>] [resumes <n>] | reset` }
    const next: Session = { ...s, limits: parsed === 'reset' ? {} : { ...s.limits, ...parsed } }
    await putSession($, next)
    await log($, `limits ${parsed === 'reset' ? 'reset' : `set: ${JSON.stringify(parsed)}`}`)
    return { text: `self-compact limits for this session:\n${describe(next)}` }
  })

  // Every compaction of the main conversation: add the configured instructions on
  // the way down, the carried text after the summary on the way up. No .catch
  // fallback: it would run the compaction again when the engine refuses it.
  on('session.compact', async ($, e, next) => {
    if (e.agentId !== undefined || e.trigger === 'precompute') return next(e)
    const job = running
    const instructions = join(e.instructions, alwaysInstructions)
    const res = await next(instructions === e.instructions ? e : { ...e, instructions })
    if (res.skip !== undefined) return res
    const carry = join(alwaysCarry, job && jobCarry(job))
    if (job) job.carried = true
    const sizes = res.tokensBefore ? ` ${res.tokensBefore} -> ${res.tokensAfter ?? '?'} tokens` : ''
    await log($, `compacted (${e.trigger}${job ? ', self' : ''})${sizes}${carry ? `; carried ${carry.length} chars` : ''}`)
      .catch(() => {})
    return carry ? { ...res, messages: [...res.messages, carryMessage(carry)] } : res
  })

  // The person's own prompt resets the count of resumes in a row. A prompt that
  // starts a turn before the compaction did: tell the model the request is still
  // pending (its carry and resume were written before this prompt).
  on('prompt.submit', async ($, e, next) => {
    if (e.origin && HUMAN.includes(e.origin.kind)) {
      const s = await getSession($)
      if (s.resumes) await putSession($, { ...s, resumes: 0 })
    }
    if (!pending || running) return next(e)
    await log($, 'a prompt started a turn first; the request stays pending')
    return next({ ...e, context: [...(e.context ?? []), PENDING_NOTE] })
  }).catch(($, e, next) => next(e))

  on('turn.start', ($, e, next) => {
    openTurn = e.turnId
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined && openTurn === e.turnId) openTurn = undefined
    const done = await next(e)
    if (e.agentId !== undefined || !pending || running) return done
    if (e.isAborted || e.reason !== 'answer') {
      pending = undefined
      // Loud unless the person stopped the turn: the model scheduled this and
      // will otherwise assume it ran.
      await log($, `requested compaction dropped: the turn ended with ${e.reason}, not an answer`, !e.isAborted)
      return done
    }
    const job = pending
    if (scheduled === job) return done
    scheduled = job
    // Run outside this hook: the session must be idle for the compaction to be
    // accepted (Stop hooks of other plugins may keep it busy after turn.complete).
    $.clock.after(0, async () => {
      try {
        await compact($, job, e.turnId)
      } finally {
        if (scheduled === job) scheduled = undefined
        if (running === job) running = undefined
      }
    })
    return done
  })
}
