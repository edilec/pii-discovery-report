/**
 * The parse-failure helper.
 *
 * V8 reports a `JSON.parse` failure two ways and one of them quotes the input
 * back. For a tool whose input is a dataset of personal data, an error message
 * that reproduces the document is the leak that matters most -- so the helper
 * is pinned here against the five shapes that have caught it out across this
 * catalog, and against a wording it has never seen.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { UNPARSEABLE, parseFailureDetail } from '../src/index.mjs'
import { runCli, withTempDir, writeText } from './helpers.mjs'

function failureFor(text) {
  try {
    JSON.parse(text)
    throw new Error('that document parsed')
  } catch (error) {
    return { message: error.message, detail: parseFailureDetail(error) }
  }
}

test('a document that literally reads "at position 1" is not sliced out of its own message', () => {
  const { message, detail } = failureFor('at position 1')
  // The trap: the phrase appears INSIDE the quoted span, so a helper that looks
  // for an offset before recognising the quoting shape returns the document.
  assert.ok(message.includes('"at position 1"'))
  assert.equal(detail, "unexpected token 'a' at the start of the document")
  assert.equal(detail.includes('at position 1'), false)
})

test('a document that is only a credential is not reproduced', () => {
  // A documentation example key, not a credential: it identifies nothing and
  // opens nothing.
  const { message, detail } = failureFor('AKIAIOSFODNN7EXAMPLE')
  assert.ok(message.includes('AKIAIOSFODNN7EXAMPLE'))
  assert.equal(detail, "unexpected token 'A' at the start of the document")
  assert.equal(detail.includes('AKIAIOSFODNN7EXAMPLE'), false)
})

test('a long document with a sensitive prefix leaks neither its start nor its middle', () => {
  const padding = 'x'.repeat(200)
  const document = `{"password": "hunter2-not-a-real-secret", "padding": "${padding}", "alpha": ZQXJVBMP7W}`
  const { message, detail } = failureFor(document)
  // V8 takes its window from the offence, not from the start, so "truncate the
  // front" would not have helped here.
  assert.ok(message.includes('...'))
  assert.ok(message.includes('ZQXJVBMP7W'))
  assert.equal(detail, "unexpected token 'Z' inside the document")
  assert.equal(detail.includes('ZQXJVBMP7W'), false)
  assert.equal(detail.includes('hunter2'), false)
})

test('a quoted span containing a newline is still recognised as a quoted span', () => {
  const { message, detail } = failureFor('token=abc\nsecret=xyz')
  assert.ok(message.includes('\n'))
  // Without the `s` flag the quoting branch silently fails to match, the helper
  // falls through to the backstop, and this exact sentence is lost. Equality is
  // the assertion that notices.
  assert.equal(detail, "unexpected token 'o' at the start of the document")
  assert.equal(detail.includes('secret=xyz'), false)
})

test('the safe positional form still yields a position', () => {
  const { message, detail } = failureFor('{"a": 1,}')
  assert.ok(message.startsWith('Expected double-quoted property name'))
  assert.equal(detail, 'Expected double-quoted property name in JSON at position 8 (line 1 column 9)')
})

test('an unterminated document keeps its own wording', () => {
  assert.equal(failureFor('{"a": ').detail, 'Unexpected end of JSON input')
})

test('a wording the helper has never been taught still cannot leak', () => {
  // The backstop does not depend on the branches above being right: across the
  // measured corpus of V8 parse messages, a message with no quoted snippet
  // carries no double quote at all, so a surviving double quote means a snippet
  // survived whatever the branches concluded.
  const invented = { message: 'Some future wording about "tok3n=s3cret-value" that nobody taught this helper' }
  assert.equal(parseFailureDetail(invented), UNPARSEABLE)
  assert.equal(parseFailureDetail(invented).includes('tok3n'), false)
})

test('a non-error, a missing message and an unconvertible one are all described safely', () => {
  assert.equal(parseFailureDetail(null), UNPARSEABLE)
  assert.equal(parseFailureDetail({}), UNPARSEABLE)
  assert.equal(parseFailureDetail({ message: { toString: {} } }), UNPARSEABLE)
})

test('the CLI reports an unparsable dataset without reproducing it, and exits 2', async () => {
  await withTempDir(async (directory) => {
    const path = await writeText(directory, 'dataset.json', 'contact=ada@example.test\npin=4310')
    const result = await runCli(['--dataset', path, '--json'])
    assert.equal(result.code, 2)
    const report = JSON.parse(result.stdout)
    assert.equal(report.status, 'incomplete')
    assert.deepEqual(report.findings.map((finding) => finding.ruleId), ['dataset-unparsable'])
    assert.equal(result.stdout.includes('ada@example.test'), false)
    assert.equal(result.stdout.includes('4310'), false)
    assert.ok(report.findings[0].message.includes("unexpected token 'c' at the start of the document"))
  })
})
