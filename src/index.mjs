/**
 * pii-discovery-report
 *
 * Read a dataset somebody exported to a file, run the configured recognisers
 * over every value, and report which fields look like they hold personal data:
 * the category, the basis of the evidence, the confidence, the counts behind
 * the confidence, and masked examples.
 *
 * Three rules govern the design, and they matter more than the recognisers:
 *
 * 1. THE EXPORT IS AN INPUT. This tool opens no connection, runs no query and
 *    resolves no host. It reads a document. Everything it reports is evidence
 *    about SHAPE, and a value shaped like an identifier is not the same fact as
 *    a value that identifies a person.
 * 2. NO VALUE LEAVES IN READABLE FORM. Every example is a mask: digits become
 *    `#`, letters become `x`, a few separators survive and everything else
 *    becomes `?`. A report about personal data that quotes personal data has
 *    made the problem worse, and the report is the artefact people paste into
 *    tickets.
 * 3. UNKNOWN IS NEVER A PASS, ON BOTH SIDES. A field is reported as holding no
 *    personal data ONLY when every one of its values was examined and the whole
 *    dataset was read. A string past the length limit, an integer the document
 *    spells with more digits than a double holds, a record that is not an
 *    object, a subtree past the depth limit, a key that prints as nothing --
 *    each one makes the field `undetermined` and the run `incomplete`. Evidence
 *    dropped while examining a field makes the examination incomplete; it does
 *    not make the field clean.
 *
 * The configuration is POLICY: a problem with it means the run never had a
 * subject, so stdout stays empty and the process exits 2. The dataset is
 * EVIDENCE: a problem with it is a finding inside an `incomplete` report,
 * because a consumer needs to know which part of the dataset was not examined.
 */

import { basename, resolve } from 'node:path'

import {
  CONFIG_KEYS,
  CONFIG_SCHEMA_VERSION,
  ConfigError,
  DEFAULT_LIMITS,
  LIMIT_CEILINGS,
  LIMIT_NAMES,
  MAX_ACKNOWLEDGED,
  MAX_CELLS,
  MAX_CONFIG_BYTES,
  defaultConfig,
  validateConfig,
} from './config.mjs'
import {
  DATASET_SCHEMA_VERSION,
  SUPPORTED_SOURCES,
  observeRecords,
  pointerForPath,
  readDataset,
  readTextBounded,
} from './dataset.mjs'
import {
  CATEGORIES,
  CONFIDENCE_ORDER,
  MAX_MASKED_EXAMPLES,
  RECOGNISERS,
  RECOGNISER_IDS,
  confidenceFor,
  confidenceRank,
  recogniserById,
} from './recognisers.mjs'
import {
  RULE_IDS,
  RULE_SEVERITY,
  SEVERITIES,
  UNSETTLED_RULES,
  makeFinding,
  sortFindings,
  statusFor,
} from './rules.mjs'
import { LINE_SEPARATORS, at, byCodeUnit, msg, parseFailureDetail, rate, sanitize } from './text.mjs'

export * from './config.mjs'
export * from './dataset.mjs'
export * from './recognisers.mjs'
export * from './rules.mjs'
export * from './text.mjs'

export const TOOL_ID = 'pii-discovery-report'
export const REPORT_SCHEMA_VERSION = '1'

export const CLASSIFICATIONS = Object.freeze(['personal-data', 'uncertain', 'undetermined', 'clean'])

/**
 * Printed in every report, whatever the verdict.
 *
 * It is a top-level string rather than a finding because it is true of the run
 * as a whole. A consumer reading only the findings should still be told what
 * kind of evidence produced them, and what no amount of this evidence settles.
 */
export const DISCLAIMER =
  'This report describes one exported document that was supplied to it. The tool opens no connection, runs no '
  + 'query and resolves no host: every result here is evidence about the SHAPE of values, and a value shaped like '
  + 'an identifier is not the same fact as a value that identifies a person. A field is reported as holding no '
  + 'personal data only when every one of its values was examined; anything else is reported as undetermined.'

/** The questions this evidence cannot settle, named in the report itself. */
export const NOT_ESTABLISHED = Object.freeze([
  'whether a value that has the shape of an identifier belongs to a real person',
  'whether a field this run reports as clean holds personal data in rows outside this export',
  'personal data quoted inside free text, which no recogniser here reads: every recogniser matches a whole value',
  'the lawful basis, retention period or sensitivity of anything found, none of which is in the document',
])

const EMPTY_SUMMARY = Object.freeze({
  records: 0,
  recordsRead: 0,
  fields: 0,
  personalData: 0,
  uncertain: 0,
  undetermined: 0,
  clean: 0,
  valuesExamined: 0,
  valuesUnexamined: 0,
})

/** Candidates sort strongest first: confidence, then match rate, then id. */
function compareCandidates(a, b) {
  return (
    confidenceRank(b.confidence) - confidenceRank(a.confidence)
    || b.matchRate - a.matchRate
    || byCodeUnit(a.recogniser, b.recogniser)
  )
}

function candidatesFor(observation, config) {
  const candidates = []
  for (const id of config.recognisers) {
    const recogniser = recogniserById(id)
    if (recogniser.matchesValue === null) {
      if (!observation.nameMatched.has(id)) continue
      candidates.push({
        recogniser: id,
        category: recogniser.category,
        basis: recogniser.basis,
        confidence: confidenceFor(recogniser, 0, 0),
        matched: 0,
        examined: 0,
        matchRate: 0,
        valuesClassified: false,
      })
      continue
    }
    const matched = observation.matched.get(id) ?? 0
    if (matched <= 0) continue
    candidates.push({
      recogniser: id,
      category: recogniser.category,
      basis: recogniser.basis,
      confidence: confidenceFor(recogniser, matched, observation.evaluated),
      matched,
      examined: observation.evaluated,
      matchRate: rate(matched, observation.evaluated),
      valuesClassified: true,
    })
  }
  return candidates.sort(compareCandidates)
}

/**
 * Turn one field's counters into a classification.
 *
 * `clean` is the only word here that makes a claim about ABSENCE, so it is the
 * one with the strictest precondition: every value examined, and the dataset
 * read in full. Everything else is either a positive finding or an admission.
 */
export function classifyField(observation, config, datasetComplete, acknowledged = false) {
  const unexamined = observation.tooLong + observation.notExact
  const candidates = candidatesFor(observation, config)
  const floor = confidenceRank(config.minConfidence)
  const strong = candidates.filter((candidate) => confidenceRank(candidate.confidence) >= floor)
  const distinct = (list) => [...new Set(list.map((candidate) => candidate.category))].sort(byCodeUnit)

  // An acknowledged field is one the operator has DECLARED to hold personal
  // data. That declaration is stronger evidence than any shape, so it settles
  // the question in the direction of presence -- never in the direction of
  // absence. It cannot silence a value this run failed to examine: those
  // findings are raised for every field, acknowledged or not, because an
  // unexamined value may hold a category nobody declared.
  if (acknowledged) {
    const list = strong.length > 0 ? strong : candidates
    const categories = distinct(list)
    return {
      classification: 'personal-data',
      category: list.length > 0 ? list[0].category : null,
      categories,
      categoryCertain: categories.length <= 1,
      confidence: list.length > 0 ? list[0].confidence : null,
      candidates,
      unexamined,
    }
  }

  if (strong.length > 0) {
    const categories = distinct(strong)
    return {
      classification: 'personal-data',
      category: strong[0].category,
      categories,
      categoryCertain: categories.length === 1,
      confidence: strong[0].confidence,
      candidates,
      unexamined,
    }
  }
  if (candidates.length > 0) {
    const categories = distinct(candidates)
    return {
      classification: 'uncertain',
      category: candidates[0].category,
      categories,
      categoryCertain: categories.length === 1,
      confidence: candidates[0].confidence,
      candidates,
      unexamined,
    }
  }
  if (unexamined > 0 || !datasetComplete) {
    return {
      classification: 'undetermined',
      category: null,
      categories: [],
      categoryCertain: false,
      confidence: null,
      candidates,
      unexamined,
    }
  }
  return {
    classification: 'clean',
    category: null,
    categories: [],
    categoryCertain: true,
    confidence: null,
    candidates,
    unexamined,
  }
}

function datasetLevelFindings(state, records, limits, file, fieldCount) {
  const findings = []
  if (state.recordsTruncated) {
    findings.push(makeFinding(
      'record-limit-exceeded',
      msg`The export holds ${String(records.length)} records and this run reads at most
          ${String(limits.maxRecords)}, so the records after that were not examined at all.`,
      at(file, '/records'),
      { suggestion: 'Raise limits.maxRecords deliberately, or split the export.' },
    ))
  }
  if (state.invalidRecords > 0) {
    findings.push(makeFinding(
      'record-invalid',
      msg`${String(state.invalidRecords)} entry or entries in "records" are not JSON objects, starting at
          index ${String(state.firstInvalidRecord)}. Whatever they held was not examined.`,
      at(file, `/records/${state.firstInvalidRecord}`),
      { suggestion: 'Export each record as a JSON object.' },
    ))
  }
  if (state.fieldsTruncated) {
    findings.push(makeFinding(
      'field-limit-exceeded',
      msg`The export uses more than the ${String(limits.maxFields)} distinct field paths this run tracks,
          so ${String(state.droppedObservations)} value or values were not attributed to any field.`,
      at(file, '/records'),
      { suggestion: 'Raise limits.maxFields deliberately, or narrow the export.' },
    ))
  }
  if (state.tooDeep > 0) {
    findings.push(makeFinding(
      'record-too-deep',
      msg`${String(state.tooDeep)} subtree or subtrees are nested deeper than the ${String(limits.maxDepth)}
          levels this run walks, first at ${state.firstTooDeepPath === null ? '(the record root)' : state.firstTooDeepPath}.
          Nothing inside them was examined.`,
      at(file, '/records'),
      { suggestion: 'Raise limits.maxDepth deliberately, or flatten the export.' },
    ))
  }
  if (state.unusablePaths > 0) {
    findings.push(makeFinding(
      'field-path-unusable',
      msg`${String(state.unusablePaths)} key or keys cannot be used as a field path, first in record
          ${String(state.firstUnusableRecord)}: a key prints as nothing, is longer than a path this tool
          prints, or would not print exactly as it is stored. Their values were not examined, because two
          such keys would share one line of this report.`,
      at(file, '/records'),
      { suggestion: 'Give every field a printable name shorter than the path limit.' },
    ))
  }
  if (fieldCount === 0) {
    findings.push(makeFinding(
      'no-fields-checked',
      msg`No field was examined, so this run establishes nothing about the export.`,
      at(file, '/records'),
      { suggestion: 'Check that the export holds records with fields.' },
    ))
  }
  return findings
}

function fieldFindings(entry, file) {
  const findings = []
  const pointer = entry.pointer
  if (entry.classification === 'personal-data') {
    // Both halves are built with `msg` rather than as plain template strings,
    // because prose interpolated as a VALUE is prose the claim check never
    // sees. A SafeMessage is inserted verbatim precisely because it has already
    // been through it.
    const shown = entry.maskedExamples.length > 0
      ? msg` Masked example: ${entry.maskedExamples[0]}.`
      : msg``
    const top = entry.candidates.length > 0 ? entry.candidates[0] : null
    const because = top === null
      ? msg`no recogniser matched any value in it`
      : msg`${String(entry.values.matched)} of ${String(entry.values.examined)} values examined matched
            ${top.recogniser}, basis ${top.basis}`
    if (entry.acknowledged) {
      findings.push(makeFinding(
        'personal-data-acknowledged',
        msg`The configuration acknowledges the field ${entry.path} as personal data
            (${because}).${shown}`,
        at(file, pointer),
      ))
    } else {
      findings.push(makeFinding(
        'personal-data-detected',
        msg`The field ${entry.path} looks like ${entry.category} at ${entry.confidence} confidence
            (${because}).${shown}`,
        at(file, pointer),
        { suggestion: 'Confirm the field against the system of record, then list it under "acknowledged" or remove it from the export.' },
      ))
    }
    if (!entry.categoryCertain) {
      findings.push(makeFinding(
        'classification-ambiguous',
        msg`The field ${entry.path} matches more than one category at or above the configured confidence:
            ${entry.categories.join(', ')}. The category reported is the strongest candidate and the others
            are listed beside it; which one the field actually holds is not settled by shape alone.`,
        at(file, pointer),
        { suggestion: 'Read the field definition, then narrow "recognisers" to the categories this export can hold.' },
      ))
    }
  }
  if (entry.classification === 'uncertain') {
    const best = entry.candidates[0]
    findings.push(makeFinding(
      'classification-uncertain',
      msg`The field ${entry.path} matched ${best.recogniser} on basis ${best.basis} at ${best.confidence}
          confidence, which is below the configured minimum. That is not enough to call it ${best.category},
          and it is not enough to call the field free of personal data either, so neither is reported.`,
      at(file, pointer),
      { suggestion: 'Inspect the field, then either lower minConfidence or acknowledge the field once its contents are known.' },
    ))
  }
  if (entry.values.tooLong > 0) {
    findings.push(makeFinding(
      'value-too-long',
      msg`${String(entry.values.tooLong)} value or values in ${entry.path} are longer than the configured
          maximum, so no recogniser saw them. This field is reported as undetermined rather than clean.`,
      at(file, pointer),
      { suggestion: 'Raise limits.maxValueLength deliberately, or review the long values by hand.' },
    ))
  }
  if (entry.values.notExact > 0) {
    findings.push(makeFinding(
      'value-not-exactly-representable',
      msg`${String(entry.values.notExact)} whole number or numbers in ${entry.path} are outside the range a
          JSON reader keeps digit for digit, so the digits this tool would examine are not the digits in the
          document and it did not examine them. This field is reported as undetermined rather than clean.`,
      at(file, pointer),
      { suggestion: 'Export identifiers as JSON strings so that every digit survives the round trip.' },
    ))
  }
  return findings
}

/**
 * Build the report from observations. Pure: no clock, no file system, no order
 * that depends on anything but the documents.
 */
export function buildReport({ fields, state, records, config, file, dataset }) {
  const datasetComplete =
    state.invalidRecords === 0
    && !state.recordsTruncated
    && !state.fieldsTruncated
    && state.tooDeep === 0
    && state.unusablePaths === 0

  const entries = []
  for (const observation of fields.values()) {
    const acknowledged = config.acknowledged.includes(observation.path)
    const verdict = classifyField(observation, config, datasetComplete, acknowledged)
    entries.push({
      path: observation.path,
      pointer: pointerForPath(observation.path),
      classification: verdict.classification,
      category: verdict.category,
      categories: verdict.categories,
      categoryCertain: verdict.categoryCertain,
      confidence: verdict.confidence,
      acknowledged,
      values: {
        examined: observation.evaluated,
        matched: verdict.candidates.length > 0 ? verdict.candidates[0].matched : 0,
        unexamined: verdict.unexamined,
        tooLong: observation.tooLong,
        notExact: observation.notExact,
        notApplicable: observation.notApplicable,
      },
      candidates: verdict.candidates,
      maskedExamples: [...observation.examples],
    })
  }
  entries.sort((a, b) => byCodeUnit(a.path, b.path))

  const findings = datasetLevelFindings(state, records, config.limits, file, entries.length)
  for (const entry of entries) findings.push(...fieldFindings(entry, file))
  const ordered = sortFindings(findings)

  const counts = { ...EMPTY_SUMMARY, records: records.length, recordsRead: state.recordsRead, fields: entries.length }
  for (const entry of entries) {
    if (entry.classification === 'personal-data') counts.personalData += 1
    if (entry.classification === 'uncertain') counts.uncertain += 1
    if (entry.classification === 'undetermined') counts.undetermined += 1
    if (entry.classification === 'clean') counts.clean += 1
    counts.valuesExamined += entry.values.examined
    counts.valuesUnexamined += entry.values.unexamined
  }

  return {
    schemaVersion: REPORT_SCHEMA_VERSION,
    tool: TOOL_ID,
    status: statusFor(ordered),
    summary: {
      checked: entries.length,
      errors: ordered.filter((finding) => finding.severity === 'error').length,
      warnings: ordered.filter((finding) => finding.severity === 'warning').length,
      info: ordered.filter((finding) => finding.severity === 'info').length,
      ...counts,
    },
    configuration: {
      recognisers: [...config.recognisers],
      minConfidence: config.minConfidence,
      acknowledged: [...config.acknowledged],
      limits: { ...config.limits },
    },
    dataset: {
      file,
      name: dataset === null ? null : dataset.name === null ? null : sanitize(dataset.name),
      source: dataset === null ? null : dataset.source,
    },
    fields: entries,
    findings: ordered,
    disclaimer: DISCLAIMER,
    notEstablished: [...NOT_ESTABLISHED],
  }
}

function unreadableReport(findings, file, config) {
  return {
    schemaVersion: REPORT_SCHEMA_VERSION,
    tool: TOOL_ID,
    status: statusFor(findings),
    summary: {
      checked: 0,
      errors: findings.filter((finding) => finding.severity === 'error').length,
      warnings: findings.filter((finding) => finding.severity === 'warning').length,
      info: findings.filter((finding) => finding.severity === 'info').length,
      ...EMPTY_SUMMARY,
    },
    configuration: {
      recognisers: [...config.recognisers],
      minConfidence: config.minConfidence,
      acknowledged: [...config.acknowledged],
      limits: { ...config.limits },
    },
    dataset: { file, name: null, source: null },
    fields: [],
    findings: sortFindings(findings),
    disclaimer: DISCLAIMER,
    notEstablished: [...NOT_ESTABLISHED],
  }
}

/**
 * Load and validate the configuration document. Every failure is a ConfigError.
 *
 * `minConfidence` given on the command line overrides the document, and it goes
 * through exactly the same validation: an option is not a way past a check.
 */
export async function loadConfig(configPath, minConfidence = null) {
  const withOverride = (config) => {
    if (minConfidence === null) return config
    if (!CONFIDENCE_ORDER.includes(minConfidence)) {
      throw new ConfigError(
        `"minConfidence" must be one of ${CONFIDENCE_ORDER.join(', ')}, and it was `
        + `${sanitize(minConfidence, 32)}.`,
      )
    }
    return Object.freeze({ ...config, minConfidence })
  }
  if (configPath === null || configPath === undefined) return withOverride(defaultConfig())
  const absolute = resolve(process.cwd(), configPath)
  const read = await readTextBounded(absolute, MAX_CONFIG_BYTES)
  if (read.status !== 'ok') {
    throw new ConfigError(`The configuration was not read: ${sanitize(read.reason)}.`)
  }
  let document
  try {
    document = JSON.parse(read.text)
  } catch (error) {
    throw new ConfigError(`The configuration is not valid JSON: ${parseFailureDetail(error)}.`)
  }
  return withOverride(validateConfig(document))
}

/**
 * Run the discovery.
 *
 * Throws `ConfigError` for anything wrong with the configuration -- the caller
 * exits 2 with empty stdout. Returns a report for everything else, including a
 * dataset that could not be read.
 */
export async function discoverPersonalData({ dataset: datasetPath, config: configPath = null, minConfidence = null }) {
  const config = await loadConfig(configPath, minConfidence)
  if (typeof datasetPath !== 'string' || datasetPath === '') {
    throw new ConfigError('A dataset path is required.')
  }
  const absolute = resolve(process.cwd(), datasetPath)
  const file = basename(absolute)

  const read = await readTextBounded(absolute, config.limits.maxDatasetBytes)
  if (read.status !== 'ok') {
    const ruleId = read.status === 'too-large'
      ? 'dataset-too-large'
      : read.status === 'not-utf8' ? 'dataset-not-utf8' : 'dataset-unreadable'
    return unreadableReport([makeFinding(
      ruleId,
      msg`The dataset was not read: ${read.reason}.`,
      at(file, null),
      {
        suggestion: read.status === 'too-large'
          ? 'Raise limits.maxDatasetBytes deliberately, or split the export.'
          : 'Export the dataset as UTF-8 JSON at the path given to --dataset.',
      },
    )], file, config)
  }

  let document
  try {
    document = JSON.parse(read.text)
  } catch (error) {
    return unreadableReport([makeFinding(
      'dataset-unparsable',
      msg`The dataset is not valid JSON: ${parseFailureDetail(error)}.`,
      at(file, null),
      { suggestion: 'Correct the JSON. No value in this file was examined.' },
    )], file, config)
  }

  const structure = readDataset(document)
  if (!structure.ok) {
    return unreadableReport([makeFinding(
      structure.kind === 'source' ? 'dataset-source-unsupported' : 'dataset-invalid',
      msg`The dataset was not usable: ${structure.reason}. Nothing was examined.`,
      at(file, null),
      {
        suggestion: structure.kind === 'source'
          ? 'Re-export the dataset in a shape this tool documents, or extend the tool deliberately.'
          : 'Correct the document against the shape the README documents.',
      },
    )], file, config)
  }

  const { fields, state } = observeRecords(structure.dataset.records, config.limits, config.recognisers)
  return buildReport({
    fields,
    state,
    records: structure.dataset.records,
    config,
    file,
    dataset: structure.dataset,
  })
}

const SEPARATOR_PATTERN = new RegExp(`[${LINE_SEPARATORS}]`, 'gu')
const SEPARATOR_ESCAPES = new Map(
  [...LINE_SEPARATORS].map((character) => [
    character,
    `\\u${character.codePointAt(0).toString(16).padStart(4, '0')}`,
  ]),
)

/**
 * Serialise the report for stdout.
 *
 * `JSON.stringify` leaves U+2028 and U+2029 raw, and inside a JavaScript string
 * literal those two are line terminators. The payload parses as JSON either
 * way, but a field path carrying one would break a consumer that evaluates the
 * payload as JavaScript, so both are escaped here as well as stripped upstream.
 */
export function renderReport(report) {
  const json = JSON.stringify(report, null, 2)
  return `${json.replace(SEPARATOR_PATTERN, (character) => SEPARATOR_ESCAPES.get(character))}\n`
}

export function exitCodeFor(report) {
  if (report.status === 'pass') return 0
  if (report.status === 'fail') return 1
  return 2
}

/** A human summary. It goes to stderr, because stdout carries only the report. */
export function formatSummary(report) {
  const lines = report.findings.map((finding) => {
    const where = [finding.location.file, finding.location.pointer]
      .filter((part) => part !== undefined && part !== '')
      .map((part) => sanitize(part, 200))
      .join(' ')
    return `${finding.severity.toUpperCase().padEnd(7)} ${sanitize(finding.ruleId, 40).padEnd(34)} ${where}`
  })
  lines.push('')
  lines.push(
    `${report.summary.fields} field(s) over ${report.summary.recordsRead} record(s) read of `
    + `${report.summary.records}; ${report.summary.valuesExamined} value(s) examined, `
    + `${report.summary.valuesUnexamined} not examined.`,
  )
  lines.push(
    `${report.summary.personalData} field(s) look like personal data, ${report.summary.uncertain} uncertain, `
    + `${report.summary.undetermined} undetermined, ${report.summary.clean} with every value examined and nothing matched.`,
  )
  lines.push(
    `${report.summary.errors} error, ${report.summary.warnings} warning, ${report.summary.info} info. `
    + `Status ${report.status}.`,
  )
  lines.push(report.disclaimer)
  return `${lines.join('\n')}\n`
}

/** Exported so the catalog and the limits can be asserted against the documents. */
export const CATALOG = Object.freeze({
  toolId: TOOL_ID,
  ruleIds: RULE_IDS,
  ruleSeverity: RULE_SEVERITY,
  unsettledRules: UNSETTLED_RULES,
  severities: SEVERITIES,
  recogniserIds: RECOGNISER_IDS,
  categories: CATEGORIES,
  confidences: CONFIDENCE_ORDER,
  classifications: CLASSIFICATIONS,
  configKeys: CONFIG_KEYS,
  limitNames: LIMIT_NAMES,
  defaultLimits: DEFAULT_LIMITS,
  limitCeilings: LIMIT_CEILINGS,
  maxCells: MAX_CELLS,
  maxConfigBytes: MAX_CONFIG_BYTES,
  maxAcknowledged: MAX_ACKNOWLEDGED,
  maxMaskedExamples: MAX_MASKED_EXAMPLES,
  supportedSources: SUPPORTED_SOURCES,
  datasetSchemaVersion: DATASET_SCHEMA_VERSION,
  configSchemaVersion: CONFIG_SCHEMA_VERSION,
  recognisers: RECOGNISERS.map((recogniser) => ({
    id: recogniser.id,
    category: recogniser.category,
    basis: recogniser.basis,
    maxConfidence: recogniser.maxConfidence,
  })),
})
