/**
 * Severity, pinned behaviourally.
 *
 * A severity table asserted against a hand-written expected map in the tests is
 * three declarations agreeing with each other, and a coordinated edit of all
 * three passes. Severity decides the EXIT CODE, so the exit code is what these
 * tests assert: three declarations can be edited together, a process exit
 * status cannot be edited at all.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  RULE_IDS,
  RULE_SEVERITY,
  SEVERITIES,
  UNSETTLED_RULES,
  makeFinding,
  marksUnsettled,
  msg,
  severityFor,
  statusFor,
} from '../src/index.mjs'
import { runCli, withTempDir, writeJson } from './helpers.mjs'

async function runOn(records, config = null) {
  return withTempDir(async (directory) => {
    const dataset = await writeJson(directory, 'dataset.json', {
      schemaVersion: '1',
      source: 'tabular-export',
      records,
    })
    const args = ['--dataset', dataset, '--json']
    if (config !== null) args.push('--config', await writeJson(directory, 'config.json', { schemaVersion: '1', ...config }))
    const result = await runCli(args)
    return { result, report: result.stdout === '' ? null : JSON.parse(result.stdout) }
  })
}

test('an error finding is exit 1, and that is what "error" means here', async () => {
  const { result, report } = await runOn([
    { contact: 'ada@example.test' }, { contact: 'grace@example.test' },
    { contact: 'alan@example.test' }, { contact: 'edsger@example.test' },
  ])
  assert.deepEqual(report.findings.map((finding) => finding.ruleId), ['personal-data-detected'])
  assert.equal(report.findings[0].severity, 'error')
  assert.equal(report.status, 'fail')
  assert.equal(result.code, 1)
})

test('an info finding alone is exit 0, and the field is still reported as personal data', async () => {
  const { result, report } = await runOn(
    [
      { contact: 'ada@example.test' }, { contact: 'grace@example.test' },
      { contact: 'alan@example.test' }, { contact: 'edsger@example.test' },
    ],
    { acknowledged: ['contact'] },
  )
  assert.deepEqual(report.findings.map((finding) => finding.ruleId), ['personal-data-acknowledged'])
  assert.equal(report.findings[0].severity, 'info')
  assert.equal(report.fields[0].classification, 'personal-data')
  assert.equal(report.status, 'pass')
  assert.equal(result.code, 0)
})

test('a warning that leaves a question open is exit 2, not exit 0', async () => {
  const { result, report } = await runOn([{ ref: '987-65-4320' }, { ref: 'a' }, { ref: 'b' }, { ref: 'c' }])
  assert.deepEqual(report.findings.map((finding) => finding.ruleId), ['classification-uncertain'])
  assert.equal(report.findings[0].severity, 'warning')
  assert.equal(report.status, 'incomplete')
  assert.equal(result.code, 2)
})

test('missing evidence outranks a policy failure', () => {
  const findings = [
    { ruleId: 'personal-data-detected', severity: 'error' },
    { ruleId: 'record-invalid', severity: 'error' },
  ]
  assert.equal(statusFor(findings), 'incomplete')
  assert.equal(statusFor([findings[0]]), 'fail')
  assert.equal(statusFor([]), 'pass')
})

test('the severity table is the only place a severity is written down', () => {
  assert.deepEqual([...RULE_IDS].sort(), Object.keys(RULE_SEVERITY).sort())
  for (const ruleId of RULE_IDS) {
    assert.ok(SEVERITIES.includes(severityFor(ruleId)), ruleId)
  }
  assert.throws(() => severityFor('no-such-rule'), /Unknown ruleId/u)
  assert.throws(() => marksUnsettled('no-such-rule'), /Unknown ruleId/u)
  for (const ruleId of UNSETTLED_RULES) {
    assert.ok(RULE_IDS.includes(ruleId), ruleId)
    assert.equal(marksUnsettled(ruleId), true, ruleId)
  }
})

test('a finding cannot be built with a raw string, and cannot be built for an unknown rule', () => {
  assert.throws(
    () => makeFinding('no-fields-checked', 'a bare string', {}),
    /must build its message with the msg tagged template/u,
  )
  assert.throws(() => makeFinding('invented-rule', msg`text`, {}), /Unknown ruleId/u)
})

test('this tool refuses to write a sentence that claims more than it can know', () => {
  assert.throws(() => msg`This field is definitely personal data.`, /may not claim more than pattern evidence/u)
  assert.throws(() => msg`We verified the record against the source.`, /may not claim more than pattern evidence/u)
  // The scan looks at what this tool WROTE, never at what it READ: a dataset
  // whose field is literally named `proven_customer` is data, and must not stop
  // the run.
  const built = msg`The field ${'proven_customer'} was examined.`
  assert.equal(built.text, 'The field proven_customer was examined.')
})

test('prose composed in two halves is checked in both, because a half is not a value', () => {
  // A message built as a plain template string and then interpolated would be
  // prose the claim check never sees. Composing with `msg` keeps every literal
  // inside the check, and the composed half is inserted verbatim rather than
  // sanitised, because it has already been through it.
  const half = msg`with ${'a value'} in it`
  const whole = msg`A sentence ${half}.`
  assert.equal(whole.text, 'A sentence with a value in it.')

  // Inserted VERBATIM, not sanitised. The distinction is observable because
  // sanitising trims, and a composed half that opens with a space would lose it
  // and run into the word before: `...).Masked example:` rather than
  // `...). Masked example:`. This assertion is what fails if the verbatim
  // branch is removed -- the throwing test above would not, because the inner
  // message throws while it is being built.
  assert.equal(msg`A${msg` B`}`.text, 'A B')
  assert.throws(() => msg`A sentence ${msg`that is definitely true`}.`, /may not claim more/u)

  // And an untrusted value carrying the same word is still only sanitised: it
  // is data, and data does not stop the run.
  assert.equal(msg`Field ${'definitely_paid'} seen.`.text, 'Field definitely_paid seen.')
})
