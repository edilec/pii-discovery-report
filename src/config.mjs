/**
 * The configuration document: which recognisers run, how confident a candidate
 * must be before it fails the run, which fields are already acknowledged, and
 * the limits.
 *
 * The configuration is POLICY, not evidence. A problem with it means the run
 * never had a subject, so every failure here is a `ConfigError`: the process
 * exits 2 with an EMPTY stdout and the message on stderr. That is the contract
 * for a configuration error, and emitting a report about a run that never
 * started would be worse than saying nothing.
 *
 * Unknown keys are refused rather than ignored. A one-character typo in a limit
 * name must not turn a real failure into a green run -- that has happened in
 * this catalog, and the key was documented.
 */

import { CONFIDENCE_ORDER, RECOGNISER_IDS } from './recognisers.mjs'
import { MAX_FIELD_PATH_LENGTH, isUsableName, sanitize } from './text.mjs'

export class ConfigError extends Error {
  constructor(message) {
    super(message)
    this.name = 'ConfigError'
  }
}

export const CONFIG_SCHEMA_VERSION = '1'

/** The configuration document itself is bounded before it is read. */
export const MAX_CONFIG_BYTES = 65536

export const DEFAULT_LIMITS = Object.freeze({
  maxDatasetBytes: 4194304,
  maxRecords: 5000,
  maxFields: 256,
  maxValueLength: 4096,
  maxDepth: 8,
})

/**
 * The ceiling each limit may be raised to.
 *
 * A limit exists so that a document this tool calls legal cannot exhaust
 * memory, and a limit a caller may raise without bound is not a limit. The
 * ceilings are chosen together: `maxDatasetBytes` bounds the parsed document,
 * and `maxRecords * maxFields` bounds the traversal, which is why that product
 * is checked as well as the two factors.
 */
export const LIMIT_CEILINGS = Object.freeze({
  maxDatasetBytes: 16777216,
  maxRecords: 200000,
  maxFields: 4096,
  maxValueLength: 65536,
  maxDepth: 32,
})

/** The most field observations one run may make. Checked before any file is opened. */
export const MAX_CELLS = 2000000

export const LIMIT_NAMES = Object.freeze(Object.keys(DEFAULT_LIMITS))

export const CONFIG_KEYS = Object.freeze([
  'schemaVersion',
  'recognisers',
  'minConfidence',
  'acknowledged',
  'limits',
])

export const MAX_ACKNOWLEDGED = 1024

export function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function refuse(message) {
  throw new ConfigError(message)
}

function validateLimits(raw) {
  const limits = { ...DEFAULT_LIMITS }
  if (raw === undefined) return limits
  if (!isRecord(raw)) refuse('The configuration key "limits" must be an object.')
  for (const key of Object.keys(raw)) {
    if (!LIMIT_NAMES.includes(key)) {
      refuse(`Unknown limit "${sanitize(key, 64)}". Known limits: ${LIMIT_NAMES.join(', ')}.`)
    }
  }
  for (const key of LIMIT_NAMES) {
    if (raw[key] === undefined) continue
    const value = raw[key]
    if (!Number.isSafeInteger(value) || value < 1 || value > LIMIT_CEILINGS[key]) {
      refuse(
        `The limit "${key}" must be a whole number from 1 to ${LIMIT_CEILINGS[key]}, `
        + `and it was ${sanitize(value, 64)}.`,
      )
    }
    limits[key] = value
  }
  if (limits.maxRecords * limits.maxFields > MAX_CELLS) {
    refuse(
      `maxRecords multiplied by maxFields is ${limits.maxRecords * limits.maxFields}, which is more `
      + `than the ${MAX_CELLS} field observations one run may make. Lower one of them.`,
    )
  }
  return limits
}

function validateRecognisers(raw) {
  if (raw === undefined) return [...RECOGNISER_IDS]
  if (!Array.isArray(raw) || raw.length === 0) {
    refuse('The configuration key "recognisers" must be a non-empty array of recogniser ids.')
  }
  const chosen = []
  for (const entry of raw) {
    if (typeof entry !== 'string' || !RECOGNISER_IDS.includes(entry)) {
      refuse(
        `Unknown recogniser "${sanitize(entry, 64)}". Known recognisers: ${RECOGNISER_IDS.join(', ')}.`,
      )
    }
    if (chosen.includes(entry)) refuse(`The recogniser "${entry}" is listed twice.`)
    chosen.push(entry)
  }
  return chosen
}

function validateAcknowledged(raw) {
  if (raw === undefined) return []
  if (!Array.isArray(raw)) refuse('The configuration key "acknowledged" must be an array of field paths.')
  if (raw.length > MAX_ACKNOWLEDGED) {
    refuse(`"acknowledged" holds ${raw.length} entries, which is more than the ${MAX_ACKNOWLEDGED} allowed.`)
  }
  const paths = []
  for (const entry of raw) {
    // The rendered form is what decides, not the raw one: a path of U+200E
    // passes `trim().length > 0` and then acknowledges a field whose name
    // prints as nothing, which would silence a real finding invisibly. An entry
    // that cannot be compared is refused rather than dropped, because an index
    // built from discarded evidence makes every comparison against it
    // incomplete -- here, it would silently un-acknowledge a field.
    if (!isUsableName(entry, MAX_FIELD_PATH_LENGTH)) {
      refuse(
        `Every "acknowledged" entry must be a field path of at most ${MAX_FIELD_PATH_LENGTH} characters `
        + `that prints exactly as it is written, and "${sanitize(entry, 64)}" does not.`,
      )
    }
    if (paths.includes(entry)) refuse(`The acknowledged field "${sanitize(entry, 64)}" is listed twice.`)
    paths.push(entry)
  }
  return paths
}

export function validateConfig(document) {
  if (!isRecord(document)) refuse('The configuration document must be a JSON object.')
  for (const key of Object.keys(document)) {
    if (!CONFIG_KEYS.includes(key)) {
      refuse(`Unknown configuration key "${sanitize(key, 64)}". Known keys: ${CONFIG_KEYS.join(', ')}.`)
    }
  }
  if (document.schemaVersion !== CONFIG_SCHEMA_VERSION) {
    refuse(
      `The configuration declares schemaVersion ${sanitize(document.schemaVersion, 32)}; `
      + `this tool reads version ${CONFIG_SCHEMA_VERSION}.`,
    )
  }
  const minConfidence = document.minConfidence ?? 'medium'
  if (!CONFIDENCE_ORDER.includes(minConfidence)) {
    refuse(
      `"minConfidence" must be one of ${CONFIDENCE_ORDER.join(', ')}, and it was `
      + `${sanitize(minConfidence, 32)}.`,
    )
  }
  return Object.freeze({
    recognisers: Object.freeze(validateRecognisers(document.recognisers)),
    minConfidence,
    acknowledged: Object.freeze(validateAcknowledged(document.acknowledged)),
    limits: Object.freeze(validateLimits(document.limits)),
  })
}

/** The configuration a run uses when none is supplied. */
export function defaultConfig() {
  return validateConfig({ schemaVersion: CONFIG_SCHEMA_VERSION })
}
