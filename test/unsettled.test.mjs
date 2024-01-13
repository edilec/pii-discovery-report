/**
 * Which rules make a run `incomplete`, one rule at a time.
 *
 * Membership of the unsettled set -- not severity -- is what turns an open
 * question into exit 2. A sweep found three memberships whose deletion left the
 * whole suite green: `dataset-invalid`, `dataset-not-utf8` and
 * `record-too-deep`. The last one is the instructive one. Its own test DOES
 * assert `incomplete`, and it passed with the membership gone, because the
 * report it drives also raises `no-fields-checked` -- another unsettled rule,
 * holding the status up on its own.
 *
 * So every rule is asked here ALONE, through the two functions that decide the
 * exit code, and the lists below are written out literally. Deriving them from
 * the code would make this file agree with whatever the code says.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  RULE_IDS,
  at,
  byCodeUnit,
  exitCodeFor,
  makeFinding,
  msg,
  statusFor,
} from '../src/index.mjs'
import { datasetDocument, runCli, withTempDir, writeJson, writeText } from './helpers.mjs'

/** A question this run was asked and did not settle: exit 2, never 0 and never 1. */
const UNSETTLED = [
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
]

/** Settled findings: they report a verdict this run DID reach. */
const SETTLED = [
  'classification-ambiguous',
  'personal-data-acknowledged',
  'personal-data-detected',
]

const findingFor = (ruleId) => makeFinding(ruleId, msg`a finding`, at('dataset.json', null))

test('each unsettled rule produces incomplete and exit 2 on its own, with nothing else to hold it up', () => {
  for (const ruleId of UNSETTLED) {
    const status = statusFor([findingFor(ruleId)])
    assert.equal(status, 'incomplete', ruleId)
    assert.equal(exitCodeFor({ status }), 2, ruleId)
  }
})

test('a settled rule on its own is never incomplete, and each lands where its severity says', () => {
  for (const ruleId of SETTLED) {
    assert.notEqual(statusFor([findingFor(ruleId)]), 'incomplete', ruleId)
  }
  assert.equal(exitCodeFor({ status: statusFor([findingFor('personal-data-detected')]) }), 1)
  assert.equal(exitCodeFor({ status: statusFor([findingFor('personal-data-acknowledged')]) }), 0)
  // An open CATEGORY is not an open DETECTION, so this one alone does not
  // refuse a verdict -- and beside the detection it does not soften it either.
  assert.equal(exitCodeFor({ status: statusFor([findingFor('classification-ambiguous')]) }), 0)
  assert.equal(
    statusFor([findingFor('classification-ambiguous'), findingFor('personal-data-detected')]),
    'fail',
  )
  // Missing evidence outranks a policy failure, whichever order they arrive in.
  assert.equal(statusFor([findingFor('personal-data-detected'), findingFor('value-too-long')]), 'incomplete')
})

test('every rule in the catalog is placed in exactly one of those two lists', () => {
  // So a rule added later cannot slip in without a decision about exit 2.
  assert.deepEqual([...UNSETTLED, ...SETTLED].sort(byCodeUnit), [...RULE_IDS])
  assert.equal(new Set([...UNSETTLED, ...SETTLED]).size, UNSETTLED.length + SETTLED.length)
})

test('a dataset whose records are not an array is incomplete at exit 2, not a policy failure', async () => {
  await withTempDir(async (directory) => {
    const path = await writeJson(directory, 'dataset.json', {
      schemaVersion: '1',
      source: 'tabular-export',
      records: { first: { contact: 'ada@example.test' } },
    })
    const result = await runCli(['--dataset', path, '--json'])
    assert.equal(result.code, 2)
    const report = JSON.parse(result.stdout)
    assert.equal(report.status, 'incomplete')
    assert.deepEqual(report.findings.map((finding) => finding.ruleId), ['dataset-invalid'])
    assert.equal(report.summary.checked, 0)
    assert.match(report.findings[0].message, /the key "records" is not an array/u)
  })
})

test('a dataset that is not UTF-8 is incomplete at exit 2, and no byte of it is decoded', async () => {
  await withTempDir(async (directory) => {
    const { writeFile } = await import('node:fs/promises')
    const { join } = await import('node:path')
    const path = join(directory, 'dataset.json')
    // A lone 0x80 continuation byte: valid Latin-1, never valid UTF-8.
    const text = Buffer.from(JSON.stringify(datasetDocument([{ contact: 'ada@example.test' }])), 'utf8')
    await writeFile(path, Buffer.concat([text.subarray(0, 20), Buffer.from([0x80]), text.subarray(20)]))
    const result = await runCli(['--dataset', path, '--json'])
    assert.equal(result.code, 2)
    const report = JSON.parse(result.stdout)
    assert.equal(report.status, 'incomplete')
    assert.deepEqual(report.findings.map((finding) => finding.ruleId), ['dataset-not-utf8'])
    assert.match(report.findings[0].message, /the bytes are not valid UTF-8/u)
    assert.equal(result.stdout.includes('ada@example.test'), false)
  })
})

test('a subtree past the depth limit is incomplete on its own, with fields still examined', async () => {
  // The masked case: the suite's own maxDepth test raises `no-fields-checked`
  // alongside, which is unsettled too. Here a field IS examined, so this rule
  // is the only thing between the run and exit 0.
  await withTempDir(async (directory) => {
    const path = await writeJson(directory, 'dataset.json', datasetDocument([
      { shallow: 'plain', deep: { a: { b: { c: 'x' } } } },
    ]))
    const config = await writeJson(directory, 'config.json', { schemaVersion: '1', limits: { maxDepth: 2 } })
    const result = await runCli(['--dataset', path, '--config', config, '--json'])
    assert.equal(result.code, 2)
    const report = JSON.parse(result.stdout)
    assert.equal(report.status, 'incomplete')
    assert.deepEqual(report.findings.map((finding) => finding.ruleId), ['record-too-deep'])
    assert.equal(report.summary.fields, 1)
    assert.equal(report.summary.valuesExamined, 1)
  })
})
