import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { posix, win32 } from 'node:path'

const TOOL_OPERATIONS = new Map([
  ['create', 'create'],
  ['write', 'write'],
  ['edit', 'write'],
  ['str_replace', 'write'],
  ['str_replace_editor', 'write'],
  ['read', 'read'],
  ['stat', 'stat'],
  ['delete', 'delete'],
  ['delete_file', 'delete'],
  ['rename', 'rename'],
  ['rename_file', 'rename'],
])

const WINDOWS = 'win32'

function stripTrailingSeparator(value) {
  if (value === '/') return value
  if (/^[A-Za-z]:\/$/.test(value)) return value
  const stripped = value.replace(/\/+$/, '')
  return stripped === '' ? '/' : stripped
}

// File entity identity: resolve against cwd when provided, unify separators to '/',
// strip a trailing separator except at a root, and fold case only on Windows.
// Relative tool paths have no stable identity without an explicit cwd, so they are
// refused instead of becoming alias entities. Display/original paths stay with the
// caller; this helper never rewrites them.
export function fileEntityRef(path, { cwd = null, platform = process.platform } = {}) {
  if (typeof path !== 'string' || path.trim() === '') return null
  const windows = platform === WINDOWS
  const api = windows ? win32 : posix
  if (!cwd && !api.isAbsolute(path)) return null
  // resolve() removes `.`/`..` segments and normalizes separators for both absolute
  // and cwd-relative paths while the caller retains the original display path.
  const resolvedPath = cwd ? api.resolve(cwd, path) : api.resolve(path)
  const unified = windows ? resolvedPath.replace(/\\/g, '/') : resolvedPath
  const normalizedPath = stripTrailingSeparator(unified)
  return {
    entityId: windows ? normalizedPath.toLowerCase() : normalizedPath,
    displayPath: path,
    resolvedPath,
    normalizedPath,
  }
}

function scopeOf(...candidates) {
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim() !== '') return candidate
  }
  throw new TypeError('observation scope must be a non-empty string')
}

function structuredArguments(call) {
  const args = call?.arguments ?? call?.args
  if (args && typeof args === 'object' && !Array.isArray(args)) return args
  if (typeof args === 'string') {
    try {
      const parsed = JSON.parse(args)
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
    } catch {
      return {}
    }
  }
  return {}
}

function callIdOf(call) {
  const id = call?.callId ?? call?.toolCallId ?? call?.id
  return id === undefined || id === null || id === '' ? 'unknown' : String(id)
}

function finite(...values) {
  return values.find((value) => Number.isFinite(value))
}

function toolOutcome(result) {
  if (!result || typeof result !== 'object') return 'unknown'
  const status = typeof result.status === 'string' ? result.status.toLowerCase() : null
  if (result.isError === true || result.ok === false || result.success === false ||
      result.error != null || status === 'error' || status === 'failure' || status === 'failed') {
    return 'failure'
  }
  if (result.isError === false || result.ok === true || result.success === true ||
      status === 'ok' || status === 'success' || status === 'succeeded') {
    return 'success'
  }
  return 'unknown'
}

function measuredValue(result) {
  if (!result || typeof result !== 'object') return {}
  const nested = result.value && typeof result.value === 'object' && !Array.isArray(result.value)
    ? result.value
    : {}
  const value = {}
  const exists = nested.exists ?? result.exists
  const size = nested.size ?? result.size
  const mtime = nested.mtime ?? nested.mtimeMs ?? result.mtime ?? result.mtimeMs
  const sha256 = nested.sha256 ?? result.sha256
  if (typeof exists === 'boolean') value.exists = exists
  if (Number.isFinite(size) && size >= 0) value.size = size
  if (Number.isFinite(mtime)) value.mtime = mtime
  if (typeof sha256 === 'string' && /^[0-9a-fA-F]{64}$/.test(sha256)) value.sha256 = sha256.toLowerCase()
  return value
}

export function observationFromTool(input) {
  const { call, result, sid, seq, recordedAt, cwd = null, platform = process.platform } = input
  const name = String(call?.name ?? call?.toolName ?? call?.action ?? '')
  const op = TOOL_OPERATIONS.get(name) ?? 'task'
  const scope = scopeOf(input.scope, call?.scope, result?.scope)
  const args = structuredArguments(call)
  const callId = callIdOf(call)
  const eventKey = `${String(sid)}:${String(seq)}:${callId}`
  const subjectRef = fileEntityRef(args.path ?? args.filePath ?? args.file_path, { cwd, platform })
  const targetRef = fileEntityRef(args.newPath ?? args.new_path ?? args.destination ?? args.targetPath,
    { cwd, platform })
  // A file operation without a structured path is not evidence about any file: it stays
  // unknown and unplaced instead of falling back to a synthetic task entity that would
  // later read as a real "current file" state.
  const structured = op !== 'task' && subjectRef !== null && (op !== 'rename' || targetRef !== null)
  const outcome = structured ? toolOutcome(result) : 'unknown'
  const validAt = finite(result?.validAt, result?.valid_at, result?.ts,
    call?.validAt, call?.valid_at, call?.ts, recordedAt)

  return {
    eventKey,
    scope,
    sid: String(sid),
    seq,
    validAt,
    recordedAt,
    op,
    outcome,
    subjectEntityId: op === 'task'
      ? `task:${eventKey}`
      : structured ? subjectRef.entityId : `unresolved:${eventKey}`,
    targetEntityId: structured && op === 'rename' ? targetRef.entityId : null,
    value: outcome === 'success' ? measuredValue(result) : {},
    generationHints: { callId },
    rawRef: eventKey,
    rawPayload: { call, result },
    source: {
      kind: 'observation',
      authority: 'host',
      displayPath: structured ? subjectRef.displayPath : null,
      resolvedPath: structured ? subjectRef.resolvedPath : null,
      ...(structured && op === 'rename'
        ? { targetDisplayPath: targetRef.displayPath, targetResolvedPath: targetRef.resolvedPath }
        : {}),
    },
    extractorVersion: 'host-v1',
  }
}

function errorPayload(error) {
  const details = error && typeof error === 'object' ? { ...error } : {}
  for (const field of ['name', 'message', 'code', 'errno', 'syscall', 'path']) {
    if (error?.[field] !== undefined) details[field] = error[field]
  }
  if (details.name === undefined) details.name = 'Error'
  if (details.message === undefined) details.message = String(error)
  return details
}

function probeBase({ scope, probeId, validAt, recordedAt }, path, resolvedPath, platform) {
  const reference = fileEntityRef(resolvedPath ?? path, { platform })
  return {
    eventKey: String(probeId),
    scope,
    sid: 'probe',
    seq: 0,
    validAt,
    recordedAt,
    subjectEntityId: reference?.entityId ?? String(resolvedPath ?? path),
    targetEntityId: null,
    generationHints: null,
    rawRef: null,
    source: {
      kind: 'probe',
      authority: 'probe',
      displayPath: path,
      resolvedPath: resolvedPath ?? path,
    },
    extractorVersion: 'probe-v1',
  }
}

function probeError(base, path, resolvedPath, probeId, error) {
  return {
    ...base,
    op: 'error',
    outcome: 'failure',
    value: {},
    rawPayload: {
      path,
      resolvedPath: resolvedPath ?? path,
      probeId,
      error: errorPayload(error),
    },
  }
}

export async function observationFromProbe(input) {
  const { path, probeId, io, cwd = null, platform = process.platform } = input
  const scope = scopeOf(input.scope)
  if (typeof path !== 'string' || path.trim() === '') {
    throw new TypeError('probe path must be a non-empty string')
  }
  const api = platform === WINDOWS ? win32 : posix
  // Relative probes are resolved against the caller's workspace cwd so a probe and
  // a host tool call can never create two alias entities for the same file. A
  // relative probe without a cwd has no stable identity and is refused.
  if (!cwd && !api.isAbsolute(path)) {
    throw new TypeError('probe relative path requires cwd')
  }
  const targetPath = cwd ? api.resolve(cwd, path) : api.resolve(path)
  const probe = { scope, probeId, validAt: input.validAt, recordedAt: input.recordedAt }
  let resolvedPath = targetPath
  try {
    if (typeof io?.realpath === 'function') resolvedPath = await io.realpath(targetPath)
  } catch (error) {
    const base = probeBase(probe, path, targetPath, platform)
    if (error?.code !== 'ENOENT' && error?.code !== 'ENOTDIR') {
      return probeError(base, path, targetPath, probeId, error)
    }
    return {
      ...base,
      op: 'probe',
      outcome: 'observed',
      value: { exists: false },
      rawPayload: { path, resolvedPath: targetPath, probeId, error: errorPayload(error) },
    }
  }

  const base = probeBase(probe, path, resolvedPath, platform)
  let stat
  try {
    stat = await io.stat(targetPath)
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') {
      return {
        ...base,
        op: 'probe',
        outcome: 'observed',
        value: { exists: false },
        rawPayload: { path, resolvedPath, probeId, error: errorPayload(error) },
      }
    }
    return probeError(base, path, resolvedPath, probeId, error)
  }

  let bytes
  try {
    const contents = await io.readFile(targetPath)
    bytes = Buffer.isBuffer(contents) ? contents : Buffer.from(contents)
  } catch (error) {
    // A read-time failure is not evidence of absence, even if its code is ENOENT.
    return probeError(base, path, resolvedPath, probeId, error)
  }

  const mtime = finite(stat?.mtimeMs,
    stat?.mtime instanceof Date ? stat.mtime.getTime() : undefined)
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  const value = { exists: true, size: bytes.length, sha256 }
  // Hash and size are the evidence; the bytes are not. Archiving the body made a
  // probe of a secrets file copy its contents into the ledger, where every later
  // reader and export could see them.
  const rawPayload = {
    path,
    resolvedPath,
    probeId,
    size: bytes.length,
    sha256,
  }
  // mtime is only observed when the host actually reported a finite one; an absent
  // mtime must not become `undefined`, which canonical JSON and the archive reject.
  if (mtime !== undefined) {
    value.mtime = mtime
    rawPayload.mtime = mtime
  }
  return {
    ...base,
    op: 'probe',
    outcome: 'observed',
    value,
    rawPayload,
  }
}

// A scope initialization opens a non-file project entity generation. It is an
// observation so the pure reducer can place it deterministically, but it derives no
// file.* facts: project assertions must never imply "this path exists".
export function observationFromScopeInit(input) {
  const { scope, validAt, recordedAt, sid = 'scope-init', seq = 0 } = input
  const scopeId = scopeOf(scope)
  if (typeof input.entityId !== 'string' || input.entityId.trim() === '') {
    throw new TypeError('scope init entityId must be a non-empty string')
  }
  const entityType = input.entityType ?? 'project'
  if (entityType !== 'project') throw new TypeError('scope init supports only project entities')
  const entityId = input.entityId.startsWith('project:')
    ? input.entityId
    : `project:${input.entityId}`
  if (!Number.isFinite(validAt) || !Number.isFinite(recordedAt)) {
    throw new TypeError('scope init requires finite validAt and recordedAt')
  }
  const eventKey = input.eventKey ?? `scope-init:${scopeId}:${entityId}:${String(sid)}:${String(seq)}`
  const detail = input.rawPayload ?? { entityId, entityType }
  return {
    eventKey,
    scope: scopeId,
    sid: String(sid),
    seq,
    validAt,
    recordedAt,
    op: 'scope_init',
    outcome: 'observed',
    subjectEntityId: entityId,
    targetEntityId: null,
    value: { entityType },
    generationHints: null,
    rawRef: input.rawRef ?? null,
    rawPayload: { ...detail, entityId, entityType },
    source: {
      kind: 'observation',
      authority: 'host',
      ...(input.source ?? {}),
    },
    extractorVersion: 'scope-init-v1',
  }
}

// A user message is archival evidence, not a derived fact. The complete text is
// stored verbatim in rawPayload so proposal quotes can only be located in the
// archive. The host must name the speaker explicitly and it must be exactly `user`;
// an assistant/model/system source is refused rather than relabelled, so a caller
// cannot turn machine output into human evidence.
export function observationFromUserMessage(input) {
  const { sid, seq, validAt, recordedAt, text, source, speaker } = input
  const scope = scopeOf(input.scope)
  if (speaker !== 'user') {
    throw new TypeError('user message speaker must be exactly "user"')
  }
  if (source !== undefined && source !== null) {
    if (typeof source !== 'object' || Array.isArray(source)) {
      throw new TypeError('user message source must be an object when provided')
    }
    if (source.kind !== undefined && source.kind !== 'user') {
      throw new TypeError('user message source kind must be exactly "user"')
    }
    if (source.authority !== undefined && source.authority !== 'user') {
      throw new TypeError('user message source authority must be exactly "user"')
    }
  }
  if (input.human !== undefined && input.human !== true) {
    throw new TypeError('user message human classification must be true')
  }
  if (typeof sid !== 'string' || sid.trim() === '') {
    throw new TypeError('user message sid must be a non-empty string')
  }
  if (!Number.isInteger(seq) || seq < 0) {
    throw new TypeError('user message seq must be a non-negative integer')
  }
  if (!Number.isFinite(validAt) || !Number.isFinite(recordedAt)) {
    throw new TypeError('user message requires finite validAt and recordedAt')
  }
  if (typeof text !== 'string' || text === '') {
    throw new TypeError('user message text must be a non-empty string')
  }
  const eventKey = `${String(sid)}:${String(seq)}:user`
  const channel = typeof source?.channel === 'string' && source.channel.trim() !== ''
    ? source.channel
    : null
  return {
    eventKey,
    scope,
    sid: String(sid),
    seq,
    validAt,
    recordedAt,
    op: 'user_message',
    outcome: 'observed',
    subjectEntityId: `message:${eventKey}`,
    targetEntityId: null,
    // Host-derived, not caller-derived: the archive layer is the only place that
    // classifies a message as human, and the host speaker is required to be user.
    value: { human: true, speaker: 'user' },
    generationHints: null,
    rawRef: channel === null ? null : `user-message:${channel}`,
    rawPayload: { text },
    source: { kind: 'user', authority: 'user', ...(channel === null ? {} : { channel }) },
    extractorVersion: 'user-message-v1',
  }
}

export function observationFromLegacy({ record, scope, rawRecord }) {
  const completeRawRecord = rawRecord === undefined ? record : rawRecord
  const value = record?.value && typeof record.value === 'object' ? record.value : {}
  const scopeId = scopeOf(scope)
  const identity = record?.rowid ?? record?.id ??
    `${record?.sid ?? 'unknown'}:${record?.seq ?? 0}:${record?.kind ?? 'record'}:${record?.key ?? 'unknown'}`
  const eventKey = `legacy:${scopeId}:${String(identity)}`
  const validAt = finite(record?.updated_ts, record?.updatedAt, record?.ts,
    record?.source?.ts, value?.updated_ts, value?.ts, 0)

  return {
    eventKey,
    scope: scopeId,
    sid: String(record?.sid ?? record?.source?.sid ?? 'legacy'),
    seq: Number.isFinite(record?.seq) ? record.seq : (record?.source?.seq ?? 0),
    validAt,
    recordedAt: validAt,
    op: 'legacy_snapshot',
    outcome: 'observed',
    subjectEntityId: String(value.path ?? record?.path ?? record?.key ?? `legacy:${identity}`),
    targetEntityId: null,
    value: {},
    generationHints: null,
    rawRef: null,
    rawPayload: completeRawRecord,
    source: { kind: 'legacy', authority: 'legacy' },
    extractorVersion: 'legacy-v1',
  }
}
