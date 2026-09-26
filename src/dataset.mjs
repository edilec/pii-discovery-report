/**
 * Reading the dataset document and observing its fields.
 *
 * The dataset is EVIDENCE, not policy, so nothing here throws. A document that
 * could not be read produces findings inside an `incomplete` report, because a
 * consumer needs to know WHICH part of the dataset was not examined.
 *
 * One rule governs every counter in this file: a value this tool did not
 * examine is counted, never skipped. The counts are what allow the caller to
 * distinguish "no personal data was recognised in this field" from "this field
 * was not entirely read", and collapsing the two is the failure this whole tool
 * exists to avoid.
 */

import { readFile, stat } from 'node:fs/promises'

import {
  MAX_MASKED_EXAMPLES,
  RECOGNISERS,
  fieldNameOf,
  maskValue,
  normaliseValue,
  recogniserById,
} from './recognisers.mjs'
import {
  MAX_PATH_LENGTH,
  byCodeUnit,
  escapePathSegment,
  isRenderableString,
  isUsableName,
  pointerToken,
  splitFieldPath,
} from './text.mjs'

export const DATASET_SCHEMA_VERSION = '1'

/**
 * The export shapes this tool reads.
 *
 * An unsupported `source` is refused rather than guessed at. A document written
 * by an exporter this tool has never seen may put values anywhere, and reading
 * it as though it were a known shape would produce field paths that do not
 * exist and counts that mean nothing.
 */
export const SUPPORTED_SOURCES = Object.freeze(['tabular-export', 'record-export'])

/**
 * Read a file as UTF-8, strictly.
 *
 * `fatal: true` is the point: a file whose bytes are not UTF-8 is reported as
 * undecodable, and encoding validity is never inferred from decoded text. A
 * dataset that legitimately contains U+FFFD is evidence of nothing. The size is
 * taken from the file system BEFORE the bytes are read, so a document over the
 * limit is refused rather than loaded and then measured.
 */
export async function readTextBounded(file, maxBytes) {
  let info
  try {
    info = await stat(file)
  } catch (error) {
    return { status: 'unreadable', reason: error.code ?? 'unknown error', text: null }
  }
  if (!info.isFile()) return { status: 'unreadable', reason: 'not a regular file', text: null }
  if (info.size > maxBytes) {
    return { status: 'too-large', reason: `${info.size} bytes exceeds the ${maxBytes} byte limit`, text: null }
  }
  let bytes
  try {
    bytes = await readFile(file)
  } catch (error) {
    return { status: 'unreadable', reason: error.code ?? 'unknown error', text: null }
  }
  let text
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return { status: 'not-utf8', reason: 'the bytes are not valid UTF-8', text: null }
  }
  return { status: 'ok', reason: null, text }
}

/**
 * The most JSON nodes -- objects and arrays -- one document may build.
 *
 * `maxDatasetBytes` bounds the TEXT and `maxRecords * maxFields` bounds the
 * TRAVERSAL. Neither bounds the PARSE, and the parse is where the memory goes:
 * every `[` or `{` in the document becomes an object on the heap, and the
 * cheapest one costs two bytes of text and about 160 bytes of memory. A file of
 * 16777216 bytes -- the ceiling `maxDatasetBytes` may be raised to, and so a
 * document this tool calls legal -- is eight million of them, and it drove peak
 * resident memory to 1.31 GB before the depth limit had a chance to refuse a
 * single subtree, because `JSON.parse` had already built the whole structure.
 *
 * So the nodes are counted in the TEXT, before it is parsed, and a document
 * over the limit is never handed to `JSON.parse` at all. The count is an upper
 * bound on what the parse would allocate and it needs no allocation itself.
 */
export const MAX_NODES = 2000000

const QUOTE = 0x22
const BACKSLASH = 0x5c
const OPEN_BRACE = 0x7b
const OPEN_BRACKET = 0x5b

/**
 * Count the objects and arrays a document would build, without building them.
 *
 * A `[` inside a string literal is text, not a node, so the scan tracks string
 * state and the backslash escape -- counting every bracket would refuse a
 * document of legal prose. The scan stops as soon as the limit is passed, so
 * the work it does is bounded too.
 */
export function countNodes(text, limit) {
  let nodes = 0
  let inString = false
  let escaped = false
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index)
    if (inString) {
      if (escaped) escaped = false
      else if (code === BACKSLASH) escaped = true
      else if (code === QUOTE) inString = false
      continue
    }
    if (code === QUOTE) {
      inString = true
      continue
    }
    if (code === OPEN_BRACE || code === OPEN_BRACKET) {
      nodes += 1
      if (nodes > limit) return { nodes, exceeded: true }
    }
  }
  return { nodes, exceeded: false }
}

/**
 * How many key/value pairs the DOCUMENT spells, counted in the text.
 *
 * `JSON.parse` resolves a repeated key before this tool sees anything: a record
 * of `{"contact": "ada@example.test", "contact": "INT-0001"}` arrives as one
 * field holding one value, and the field was reported `clean` -- an absence
 * claim over a value that existed in the document and was never examined. That
 * is the one failure this tool exists to avoid, arriving before it starts.
 *
 * The count is cheap and exact for a document that PARSED, which is the only
 * kind this is asked about: in well-formed JSON a `:` follows a string only
 * when that string is an object key, so the pairs are the strings a colon
 * follows. It is compared with the keys the parsed structure holds.
 */
export function countKeysInText(text) {
  let keys = 0
  let inString = false
  let escaped = false
  let stringEnded = -1
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]
    if (inString) {
      if (escaped) escaped = false
      else if (character === '\\') escaped = true
      else if (character === '"') {
        inString = false
        stringEnded = index
      }
      continue
    }
    if (character === '"') {
      inString = true
      continue
    }
    if (character === ':' && stringEnded >= 0) keys += 1
    // Only whitespace may sit between a key and its colon.
    if (character !== ' ' && character !== '\t' && character !== '\n' && character !== '\r') stringEnded = -1
  }
  return keys
}

/**
 * How many keys the PARSED structure holds.
 *
 * Iterative on purpose: the node bound allows a document two million levels
 * deep, and a recursive walk over one would exhaust the call stack rather than
 * answer.
 */
export function countKeysInValue(value) {
  let keys = 0
  // Only containers go on the stack. A scalar carries no key, and an array of
  // four million strings would otherwise put four million entries on it: the
  // walk has to cost about what the document costs, not a multiple of it.
  const pending = isContainer(value) ? [value] : []
  while (pending.length > 0) {
    const current = pending.pop()
    if (Array.isArray(current)) {
      for (const element of current) if (isContainer(element)) pending.push(element)
      continue
    }
    for (const key of Object.keys(current)) {
      keys += 1
      if (isContainer(current[key])) pending.push(current[key])
    }
  }
  return keys
}

function isContainer(value) {
  return typeof value === 'object' && value !== null
}

function isRecordObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Validate the dataset envelope. The shape is refused, never repaired. */
export function readDataset(document) {
  if (!isRecordObject(document)) return { ok: false, kind: 'invalid', reason: 'the document is not a JSON object' }
  if (document.schemaVersion !== DATASET_SCHEMA_VERSION) {
    return {
      ok: false,
      kind: 'invalid',
      reason: `the document does not declare schemaVersion ${DATASET_SCHEMA_VERSION}, which is the only version this tool reads`,
    }
  }
  if (typeof document.source !== 'string' || !SUPPORTED_SOURCES.includes(document.source)) {
    return {
      ok: false,
      kind: 'source',
      reason: `the export source is not one this tool reads; it reads ${SUPPORTED_SOURCES.join(' and ')}`,
    }
  }
  if (document.dataset !== undefined && !isRenderableString(document.dataset, MAX_PATH_LENGTH)) {
    return { ok: false, kind: 'invalid', reason: 'the dataset name is not a printable string' }
  }
  if (!Array.isArray(document.records)) {
    return { ok: false, kind: 'invalid', reason: 'the key "records" is not an array' }
  }
  return {
    ok: true,
    dataset: {
      name: document.dataset ?? null,
      source: document.source,
      records: document.records,
    },
  }
}

function newObservation(path, enabled) {
  const name = fieldNameOf(path)
  const nameMatched = new Set()
  // A name is evidence in both directions. It can select a recogniser whose
  // basis includes the field name, and it can REFUSE one whose value shape the
  // name says belongs to something else: a four-part build number in a column
  // called `app_version` has the shape of a dotted quad and is not an address.
  const nameRefused = new Set()
  for (const id of enabled) {
    const recogniser = recogniserById(id)
    if (recogniser.matchesName !== null && recogniser.matchesName(name)) nameMatched.add(id)
    if (recogniser.refusedByName !== null && recogniser.refusedByName(name)) nameRefused.add(id)
  }
  return {
    path,
    evaluated: 0,
    notApplicable: 0,
    tooLong: 0,
    notExact: 0,
    matched: new Map(),
    nameMatched,
    nameRefused,
    examples: [],
  }
}

/** Keep the lowest masked forms by code unit, so the examples do not depend on record order. */
function rememberExample(observation, masked) {
  if (masked === '' || observation.examples.includes(masked)) return
  observation.examples.push(masked)
  observation.examples.sort(byCodeUnit)
  if (observation.examples.length > MAX_MASKED_EXAMPLES) observation.examples.length = MAX_MASKED_EXAMPLES
}

function classifyValue(observation, raw, enabled) {
  const normalised = normaliseValue(raw)
  let matchedAny = false
  for (const recogniser of RECOGNISERS) {
    if (!enabled.includes(recogniser.id)) continue
    if (recogniser.matchesValue === null) continue
    // A recogniser whose basis includes the field name only counts values in a
    // field that name selected. A date in `shipped_on` is a date.
    if (recogniser.matchesName !== null && !observation.nameMatched.has(recogniser.id)) continue
    // And a recogniser the field name refuses counts nothing at all: the column
    // says what it holds, and this tool does not overrule it with a shape that
    // reading also has.
    if (observation.nameRefused.has(recogniser.id)) continue
    if (!recogniser.matchesValue(normalised)) continue
    observation.matched.set(recogniser.id, (observation.matched.get(recogniser.id) ?? 0) + 1)
    matchedAny = true
  }
  if (matchedAny) rememberExample(observation, maskValue(raw))
}

/**
 * Walk the records and count what each field holds.
 *
 * Every departure from "this value was examined" increments a counter that the
 * caller turns into a finding: a record that is not an object, a subtree deeper
 * than the limit, a key that prints as nothing, a string longer than the limit,
 * an integer JSON parsed to a different number than the document spells. None
 * of them is silently skipped, because a field whose values were partly skipped
 * cannot be reported as holding no personal data.
 */
export function observeRecords(records, limits, enabled) {
  const fields = new Map()
  const state = {
    recordsRead: 0,
    recordsTruncated: records.length > limits.maxRecords,
    invalidRecords: 0,
    firstInvalidRecord: null,
    tooDeep: 0,
    firstTooDeepPath: null,
    unusablePaths: 0,
    firstUnusableRecord: null,
    fieldsTruncated: false,
    droppedObservations: 0,
  }

  const observationFor = (path) => {
    const existing = fields.get(path)
    if (existing !== undefined) return existing
    if (fields.size >= limits.maxFields) {
      state.fieldsTruncated = true
      state.droppedObservations += 1
      return null
    }
    const created = newObservation(path, enabled)
    fields.set(path, created)
    return created
  }

  const recordScalar = (path, value, recordIndex) => {
    const observation = observationFor(path)
    if (observation === null) return
    if (typeof value === 'string') {
      if (value.length > limits.maxValueLength) {
        observation.tooLong += 1
        return
      }
      observation.evaluated += 1
      classifyValue(observation, value, enabled)
      return
    }
    if (typeof value === 'number') {
      // An integer outside the exactly representable range is NOT the integer
      // the document spells: the digits this tool would test are the digits of
      // the nearest double. Testing them would classify a value that was never
      // in the file.
      if (Number.isInteger(value) && !Number.isSafeInteger(value)) {
        observation.notExact += 1
        return
      }
      observation.evaluated += 1
      classifyValue(observation, String(value), enabled)
      return
    }
    // `true`, `false` and `null` carry no category this tool recognises, so
    // they are counted apart rather than counted as examined values.
    observation.notApplicable += 1
    void recordIndex
  }

  const walk = (value, path, depth, recordIndex) => {
    if (Array.isArray(value)) {
      if (depth > limits.maxDepth) {
        state.tooDeep += 1
        if (state.firstTooDeepPath === null) state.firstTooDeepPath = path
        return
      }
      for (const element of value) walk(element, `${path}[]`, depth + 1, recordIndex)
      return
    }
    if (isRecordObject(value)) {
      if (depth > limits.maxDepth) {
        state.tooDeep += 1
        if (state.firstTooDeepPath === null) state.firstTooDeepPath = path
        return
      }
      for (const key of Object.keys(value)) {
        // The rendered form decides, and it must match the stored form exactly.
        // A key that prints as nothing, one longer than a path may print, and
        // one that merely survives sanitising all collapse two different fields
        // into one line of the report, so each is counted as unexamined rather
        // than printed wrong. A key containing `.` or `[]` passes this check --
        // it prints as it is stored -- and is kept apart by escaping it into the
        // path below, which is a different collision with a different remedy.
        if (!isUsableName(key, MAX_PATH_LENGTH)) {
          state.unusablePaths += 1
          if (state.firstUnusableRecord === null) state.firstUnusableRecord = recordIndex
          continue
        }
        // The key is ESCAPED into the path. A key may legally contain the
        // characters a path is composed from, and joining them raw merged a
        // flat column named `contact.email` with the nested contact->email
        // into one entry -- one match rate, one pointer, and one
        // acknowledgement silencing a field nobody named.
        const segment = escapePathSegment(key)
        walk(value[key], path === '' ? segment : `${path}.${segment}`, depth + 1, recordIndex)
      }
      return
    }
    recordScalar(path, value, recordIndex)
  }

  const limit = Math.min(records.length, limits.maxRecords)
  for (let index = 0; index < limit; index += 1) {
    const record = records[index]
    if (!isRecordObject(record)) {
      state.invalidRecords += 1
      if (state.firstInvalidRecord === null) state.firstInvalidRecord = index
      continue
    }
    state.recordsRead += 1
    walk(record, '', 1, index)
  }

  return { fields, state }
}

/**
 * The pointer form this tool documents: the field path, one segment per level.
 *
 * The path is split by `splitFieldPath`, never on the `.` character: a flat
 * column named `contact.email` is one segment and the nested contact->email is
 * two, and splitting on the character gave both of them the pointer
 * `/contact/email`. Each key is then escaped as a JSON Pointer token, because a
 * dataset key may legally contain `/` or `~` and an unescaped one would name a
 * different field again.
 */
export function pointerForPath(path) {
  const tokens = splitFieldPath(path).map(({ segment }) => pointerToken(segment))
  return `/${tokens.join('/')}`
}
