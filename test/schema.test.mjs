/**
 * The report envelope, and the documents that describe it.
 *
 * The contract says stdout carries the JSON report and nothing else, that
 * findings are ordered deterministically, and that `location.file` is never an
 * absolute host path. Those are checked here against real output rather than
 * against a description of it.
 */

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import {
  CATALOG,
  CLASSIFICATIONS,
  RULE_IDS,
  SEVERITIES,
  TOOL_ID,
  compareFindings,
  renderReport,
} from '../src/index.mjs'
import { EXAMPLES, ROOT, reportFor, runCli } from './helpers.mjs'
import { join } from 'node:path'

const REPORT_KEYS = [
  'schemaVersion', 'tool', 'status', 'summary', 'configuration', 'dataset',
  'fields', 'findings', 'disclaimer', 'notEstablished',
]

function everyReport() {
  return [
    reportFor([{ contact: 'ada@example.test' }, { contact: 'grace@example.test' }]),
    reportFor([{ note: 'x' }]),
    reportFor([]),
    reportFor([{ note: 'x' }, null]),
    reportFor([{ long: 'x'.repeat(40) }], { limits: { maxValueLength: 8 } }),
  ]
}

test('the envelope is the shape the contract describes, in every outcome', () => {
  for (const report of everyReport()) {
    assert.deepEqual(Object.keys(report), REPORT_KEYS)
    assert.equal(report.schemaVersion, '1')
    assert.equal(report.tool, TOOL_ID)
    assert.ok(['pass', 'fail', 'incomplete'].includes(report.status))
    for (const value of Object.values(report.summary)) {
      if (typeof value === 'number') assert.ok(Number.isInteger(value), `${value} must be a whole number`)
    }
    assert.ok(Array.isArray(report.findings))
    assert.ok(Array.isArray(report.fields))
  }
})

test('every finding carries a known rule, a known severity and a relative location', () => {
  for (const report of everyReport()) {
    for (const finding of report.findings) {
      assert.ok(RULE_IDS.includes(finding.ruleId), finding.ruleId)
      assert.ok(SEVERITIES.includes(finding.severity), finding.severity)
      assert.ok(finding.message.length > 0)
      assert.equal(typeof finding.location, 'object')
      if (finding.location.file !== undefined) {
        assert.equal(finding.location.file.startsWith('/'), false)
        assert.equal(finding.location.file, 'dataset.json')
      }
      if (finding.location.pointer !== undefined) assert.ok(finding.location.pointer.startsWith('/'))
      assert.deepEqual(
        Object.keys(finding).filter((key) => !['ruleId', 'severity', 'message', 'location', 'evidence', 'suggestion'].includes(key)),
        [],
      )
    }
  }
})

test('findings come out already sorted by the documented key', () => {
  for (const report of everyReport()) {
    const resorted = [...report.findings].sort(compareFindings)
    assert.deepEqual(report.findings, resorted)
  }
})

test('every field entry uses a known classification and carries the counts behind it', () => {
  for (const report of everyReport()) {
    for (const entry of report.fields) {
      assert.ok(CLASSIFICATIONS.includes(entry.classification), entry.classification)
      assert.equal(typeof entry.values.examined, 'number')
      assert.equal(
        entry.values.unexamined,
        entry.values.tooLong + entry.values.notExact,
        'unexamined must be the sum of the reasons a value was not examined',
      )
      for (const candidate of entry.candidates) {
        assert.ok(CATALOG.recogniserIds.includes(candidate.recogniser))
        assert.ok(CATALOG.confidences.includes(candidate.confidence))
        assert.ok(candidate.matchRate >= 0 && candidate.matchRate <= 1)
      }
    }
  }
})

test('stdout is exactly one JSON document and ends with one newline', async () => {
  const result = await runCli(['--dataset', join(EXAMPLES, 'clean', 'dataset.json'), '--json'])
  assert.equal(result.stdout.endsWith('}\n'), true)
  assert.equal(result.stdout.slice(0, -1).includes('\n}\n'), false)
  JSON.parse(result.stdout)
  assert.equal(renderReport(JSON.parse(result.stdout)), result.stdout)
})

test('the tool id equals the package name and the directory it lives in', async () => {
  const manifest = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'))
  assert.equal(manifest.name, TOOL_ID)
  assert.equal(ROOT.split('/').pop(), TOOL_ID)
  assert.equal(CATALOG.toolId, TOOL_ID)
})

test('the README documents every rule, every recogniser and every limit, and invents none', async () => {
  const readme = await readFile(join(ROOT, 'README.md'), 'utf8')
  const table = (pattern) => [...readme.matchAll(pattern)].map((match) => match[1])

  const documentedRules = table(/^\| `([a-z][a-z0-9-]*)` \| (?:error|warning|info) \|/gmu)
  assert.deepEqual([...documentedRules].sort(), [...RULE_IDS].sort())

  const documentedRecognisers = table(/^\| `([a-z][a-z0-9-]*)` \| `[a-z-]+` \|/gmu)
  assert.deepEqual([...documentedRecognisers].sort(), [...CATALOG.recogniserIds].sort())

  for (const name of CATALOG.limitNames) {
    assert.ok(readme.includes(`\`${name}\``), `the README must document ${name}`)
    assert.ok(
      readme.includes(String(CATALOG.defaultLimits[name])),
      `the README must state the default for ${name}`,
    )
  }
  for (const ruleId of RULE_IDS) {
    const severity = CATALOG.ruleSeverity[ruleId]
    assert.ok(readme.includes(`| \`${ruleId}\` | ${severity} |`), `${ruleId} must be documented as ${severity}`)
  }
})
