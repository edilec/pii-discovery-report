/**
 * The rule catalog, the severity table, and the function that turns findings
 * into a status.
 *
 * Two invariants are enforced here rather than trusted:
 *
 * 1. Severity is declared exactly once, in `RULE_SEVERITY`. Every finding takes
 *    its severity from that table and an unknown rule id throws rather than
 *    defaulting to something harmless. Severity is not a label -- it is the
 *    exit code.
 * 2. `status` is a function of the findings alone. There is no `incomplete`
 *    flag to delete, because a single deleted assignment has turned an entirely
 *    unread input into a green run elsewhere in this catalog. A run that could
 *    not settle a question reports `incomplete`, and `incomplete` outranks
 *    `fail`: a run that read half the dataset has not established that the half
 *    it read is the whole story.
 */

import { SafeMessage, assertNoForbiddenClaim, byCodeUnit, sanitize } from './text.mjs'

export const SEVERITIES = Object.freeze(['error', 'warning', 'info'])

/** The one place a severity is written down. */
export const RULE_SEVERITY = Object.freeze({
  'classification-ambiguous': 'warning',
  'classification-uncertain': 'warning',
  'dataset-invalid': 'error',
  'dataset-not-utf8': 'error',
  'dataset-source-unsupported': 'error',
  'dataset-too-large': 'error',
  'dataset-unparsable': 'error',
  'dataset-unreadable': 'error',
  'field-limit-exceeded': 'error',
  'field-path-unusable': 'error',
  'no-fields-checked': 'error',
  'node-limit-exceeded': 'error',
  'personal-data-acknowledged': 'info',
  'personal-data-detected': 'error',
  'record-invalid': 'error',
  'record-limit-exceeded': 'error',
  'record-too-deep': 'error',
  'value-not-exactly-representable': 'warning',
  'value-too-long': 'warning',
})

export const RULE_IDS = Object.freeze(Object.keys(RULE_SEVERITY).sort(byCodeUnit))

/**
 * The rules that mean a question this run was asked stayed unsettled.
 *
 * Membership here -- not severity -- is what makes a run `incomplete`, and for
 * the `warning` members it is the ONLY thing standing between an unsettled
 * question and a green exit. `classification-uncertain`, `value-too-long` and
 * `value-not-exactly-representable` are warnings on purpose: none of them
 * asserts that personal data is present, and each says that the opposite claim
 * was not established either.
 *
 * `classification-ambiguous` is deliberately absent. When two recognisers of
 * different categories both match a field, the presence of personal data is
 * still asserted and reported at error severity; only the CATEGORY is open, and
 * both candidates are named in the report. Refusing a verdict there would
 * over-refuse -- an unsettled category is not an unsettled detection.
 */
export const UNSETTLED_RULES = Object.freeze([
  'classification-uncertain',
  'dataset-invalid',
  'dataset-not-utf8',
  'dataset-source-unsupported',
  'dataset-too-large',
  'dataset-unparsable',
  'dataset-unreadable',
  'field-limit-exceeded',
  'field-path-unusable',
  'no-fields-checked',
  'node-limit-exceeded',
  'record-invalid',
  'record-limit-exceeded',
  'record-too-deep',
  'value-not-exactly-representable',
  'value-too-long',
])

const UNSETTLED_SET = new Set(UNSETTLED_RULES)

export function severityFor(ruleId) {
  const severity = RULE_SEVERITY[ruleId]
  if (severity === undefined) throw new Error(`Unknown ruleId "${ruleId}"`)
  return severity
}

export function marksUnsettled(ruleId) {
  severityFor(ruleId)
  return UNSETTLED_SET.has(ruleId)
}

export function makeFinding(ruleId, message, location, extra = {}) {
  if (!(message instanceof SafeMessage)) {
    throw new Error(`Finding "${ruleId}" must build its message with the msg tagged template`)
  }
  const finding = { ruleId, severity: severityFor(ruleId), message: message.text, location }
  if (extra.evidence !== undefined) finding.evidence = sanitize(extra.evidence)
  if (extra.suggestion !== undefined) {
    assertNoForbiddenClaim(extra.suggestion, 'A finding suggestion')
    finding.suggestion = sanitize(extra.suggestion)
  }
  return finding
}

/** Findings sort by (file, pointer, ruleId, message), each by UTF-16 code unit. */
export function compareFindings(a, b) {
  return (
    byCodeUnit(a.location.file ?? '', b.location.file ?? '')
    || byCodeUnit(a.location.pointer ?? '', b.location.pointer ?? '')
    || byCodeUnit(a.ruleId, b.ruleId)
    || byCodeUnit(a.message, b.message)
  )
}

export function sortFindings(findings) {
  return [...findings].sort(compareFindings)
}

/** Status is a function of the findings alone. There is no flag to delete. */
export function statusFor(findings) {
  for (const finding of findings) {
    if (UNSETTLED_SET.has(finding.ruleId)) return 'incomplete'
  }
  for (const finding of findings) {
    if (finding.severity === 'error') return 'fail'
  }
  return 'pass'
}
