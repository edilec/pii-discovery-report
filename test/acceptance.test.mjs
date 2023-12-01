/**
 * The acceptance criteria, item by item.
 *
 *   "Seeded personal-data fixtures are found with measured false positives;
 *    values are masked and reports state classification uncertainty."
 *
 * The corpus is `examples/seeded/dataset.json`, which ships with the tool so
 * that the numbers below can be re-derived by anyone. Every value in it is
 * invented and drawn from a range reserved for documentation: `example.test`
 * addresses, the Ofcom and NANP drama telephone ranges, published card test
 * numbers, identifier prefixes that are never issued, and the TEST-NET blocks.
 *
 * The labels live HERE and nowhere in the tool's input. The tool is never told
 * which fields hold personal data; it is measured against the labels
 * afterwards, which is the only way a false positive count means anything.
 */

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'

import { EXAMPLES, runCli } from './helpers.mjs'

const SEEDED = join(EXAMPLES, 'seeded', 'dataset.json')
const SEEDED_CONFIG = join(EXAMPLES, 'seeded', 'config.json')

/** What each field actually is. The tool never sees this. */
const LABELS = Object.freeze({
  'contact.email': 'personal',
  'contact.phone': 'personal',
  'date_of_birth': 'personal',
  'full_name': 'personal',
  'government_id': 'personal',
  'last_seen_ip': 'personal',
  'payment.card_number': 'personal',
  'created_at': 'not-personal',
  'in_stock': 'not-personal',
  'legacy_ref': 'not-personal',
  'notes': 'not-personal',
  'order_ref': 'not-personal',
  'product_name': 'not-personal',
  'quantity': 'not-personal',
  'sku': 'not-personal',
  'supplier.company_name': 'not-personal',
  'unit_price': 'not-personal',
  'version': 'not-personal',
  'warehouse_code': 'not-personal',
})

async function seededReport(extraArgs = []) {
  const result = await runCli(['--dataset', SEEDED, '--config', SEEDED_CONFIG, '--json', ...extraArgs])
  return { result, report: JSON.parse(result.stdout) }
}

test('every field in the corpus is labelled, so the measurement covers all of it', async () => {
  const { report } = await seededReport()
  const paths = report.fields.map((entry) => entry.path).sort()
  assert.deepEqual(paths, Object.keys(LABELS).sort())
  assert.equal(report.summary.checked, 19)
})

test('seeded personal-data fixtures are found, each with the category it was seeded as', async () => {
  const { report } = await seededReport()
  const found = new Map(report.fields.map((entry) => [entry.path, entry]))

  const expected = [
    ['contact.email', 'email', 'high', 'email-address'],
    ['contact.phone', 'phone', 'high', 'phone-number'],
    ['date_of_birth', 'date-of-birth', 'medium', 'date-of-birth'],
    ['government_id', 'government-id', 'high', 'government-id'],
    ['last_seen_ip', 'network-identifier', 'high', 'network-address'],
    ['payment.card_number', 'payment-card', 'high', 'payment-card'],
  ]
  for (const [path, category, confidence, recogniser] of expected) {
    const entry = found.get(path)
    assert.equal(entry.classification, 'personal-data', path)
    assert.equal(entry.category, category, path)
    assert.equal(entry.confidence, confidence, path)
    assert.equal(entry.candidates[0].recogniser, recogniser, path)
    assert.equal(entry.values.examined, 12, path)
    assert.equal(entry.values.matched, 12, path)
    assert.equal(entry.candidates[0].matchRate, 1, path)
  }

  // The seventh seeded field is the one no value can prove. It is found through
  // the column name, it is acknowledged in the shipped configuration, and it
  // says plainly that no value was classified.
  const name = found.get('full_name')
  assert.equal(name.classification, 'personal-data')
  assert.equal(name.category, 'person-name')
  assert.equal(name.confidence, 'low')
  assert.equal(name.acknowledged, true)
  assert.equal(name.candidates[0].basis, 'field-name')
  assert.equal(name.candidates[0].valuesClassified, false)
  assert.equal(name.candidates[0].matched, 0)
  assert.equal(name.maskedExamples.length, 0)
})

test('the false positives on this corpus are measured, not assumed', async () => {
  const { report, result } = await seededReport()
  const personal = new Set(
    report.fields.filter((entry) => entry.classification === 'personal-data').map((entry) => entry.path),
  )
  const anyCandidate = new Set(
    report.fields.filter((entry) => entry.candidates.length > 0).map((entry) => entry.path),
  )

  const labelled = (label) => Object.keys(LABELS).filter((path) => LABELS[path] === label)
  const truePositives = labelled('personal').filter((path) => personal.has(path))
  const falseNegatives = labelled('personal').filter((path) => !personal.has(path))
  const falsePositives = labelled('not-personal').filter((path) => personal.has(path))
  const softFalsePositives = labelled('not-personal').filter((path) => anyCandidate.has(path))

  assert.equal(truePositives.length, 7)
  assert.deepEqual(falseNegatives, [])
  // One, and it is named rather than rounded away: `legacy_ref` holds internal
  // references whose shape is the shape a government identifier takes. Nothing
  // in the value distinguishes them, and this tool does not guess.
  assert.deepEqual(falsePositives, ['legacy_ref'])
  assert.deepEqual(softFalsePositives, ['legacy_ref'])
  assert.equal(labelled('not-personal').length, 12)

  // The eleven other non-personal fields draw no candidate at all: no finding,
  // no uncertainty, nothing for a reader to dismiss. Staying silent on correct
  // input is the first thing this kind of tool has to get right.
  const quiet = labelled('not-personal').filter((path) => !anyCandidate.has(path))
  assert.equal(quiet.length, 11)
  for (const path of quiet) {
    const entry = report.fields.find((candidate) => candidate.path === path)
    assert.equal(entry.classification, 'clean', path)
    assert.equal(entry.candidates.length, 0, path)
  }
  assert.equal(report.findings.filter((finding) => quiet.includes(finding.location.pointer?.slice(1))).length, 0)
  assert.equal(result.code, 1)
})

test('lowering the confidence floor changes the measurement, and the change is visible', async () => {
  const { report: strict } = await seededReport()
  const { report: loose } = await seededReport(['--min-confidence', 'low'])
  const personalIn = (report) =>
    report.fields.filter((entry) => entry.classification === 'personal-data').map((entry) => entry.path)

  assert.equal(personalIn(strict).length, 8)
  assert.equal(personalIn(loose).length, 8)

  // `high` is where the trade runs the other way: the two categories whose
  // basis is not the value alone stop reaching the floor, and both become
  // uncertain rather than clean.
  const { report: high, result } = await seededReport(['--min-confidence', 'high'])
  assert.deepEqual(
    high.fields.filter((entry) => entry.classification === 'uncertain').map((entry) => entry.path),
    ['date_of_birth'],
  )
  // Seven, not six: the acknowledged field stays personal data at every floor,
  // because the operator declared it and a declaration is not a match rate.
  assert.equal(high.summary.personalData, 7)
  assert.equal(high.status, 'incomplete')
  assert.equal(result.code, 2)
})

test('no value from the dataset survives into the report, and the masks that replace them are pinned', async () => {
  const { report, result } = await seededReport()
  const rendered = result.stdout
  const document = JSON.parse(await readFile(SEEDED, 'utf8'))

  const leaves = []
  const walk = (value) => {
    if (Array.isArray(value)) return value.forEach(walk)
    if (value !== null && typeof value === 'object') return Object.values(value).forEach(walk)
    if (typeof value === 'string') leaves.push(value)
  }
  walk(document.records)
  assert.ok(leaves.length > 150)
  for (const value of leaves) {
    assert.equal(rendered.includes(value), false, `the report reproduced ${JSON.stringify(value)}`)
  }

  // An absence assertion alone passes for the wrong reason -- an empty report
  // would satisfy it. These pin what IS there beside what is not.
  const email = report.fields.find((entry) => entry.path === 'contact.email')
  assert.deepEqual(email.maskedExamples, [
    'x.xxxx@xxxxxxx.xxxx',
    'x.xxxxx@xxxxxxx.xxxx',
    'x.xxxxxx@xxxxxxx.xxxx',
  ])
  const card = report.fields.find((entry) => entry.path === 'payment.card_number')
  assert.deepEqual(card.maskedExamples, ['####-####-####-####', '####?####?####?####'])
  assert.equal(
    report.findings.filter((finding) => finding.ruleId === 'personal-data-detected').length,
    7,
  )
  assert.ok(
    report.findings
      .find((finding) => finding.location.pointer === '/contact/email')
      .message.includes('Masked example: x.xxxx@xxxxxxx.xxxx.'),
  )
  assert.equal(result.code, 1)
})

test('a candidate below the configured confidence is reported as uncertain, never as clean', async () => {
  const { result } = await runCliOnRecords()
  const report = JSON.parse(result.stdout)
  const entry = report.fields.find((field) => field.path === 'ref')

  assert.equal(entry.classification, 'uncertain')
  assert.equal(entry.confidence, 'low')
  assert.equal(entry.candidates[0].recogniser, 'government-id')
  assert.equal(entry.candidates[0].matched, 1)
  assert.equal(entry.candidates[0].examined, 6)
  assert.equal(entry.candidates[0].matchRate, 0.1667)
  assert.equal(entry.candidates[0].basis, 'value-pattern')

  const finding = report.findings.find((item) => item.ruleId === 'classification-uncertain')
  assert.equal(finding.severity, 'warning')
  assert.ok(finding.message.includes('not enough to call the field free of personal data'))
  assert.equal(report.status, 'incomplete')
  assert.equal(result.code, 2)
})

async function runCliOnRecords() {
  const { withTempDir, writeJson } = await import('./helpers.mjs')
  return withTempDir(async (directory) => {
    const records = [
      { ref: '987-65-4320' },
      { ref: 'AB-1234' },
      { ref: 'AB-1235' },
      { ref: 'AB-1236' },
      { ref: 'AB-1237' },
      { ref: 'AB-1238' },
    ]
    const path = await writeJson(directory, 'dataset.json', {
      schemaVersion: '1',
      dataset: 'mixed',
      source: 'tabular-export',
      records,
    })
    return { result: await runCli(['--dataset', path, '--json']) }
  })
}
