/**
 * The boundary every untrusted string crosses.
 *
 * Stripping C0 and the two separators is not sanitising: four tools in this
 * catalog let the C1 range through, where U+0085 forges a line and U+009B is an
 * 8-bit control introducer, and let the bidi controls through, where U+202E
 * reverses displayed text. Every class is tested, and one of them arrives
 * through an IDENTIFIER rather than through an excerpt, because a tool that
 * sanitises its evidence field carefully and prints an identifier raw has
 * sanitised nothing.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import * as text from '../src/text.mjs'
import {
  LINE_SEPARATORS,
  MAX_PATH_LENGTH,
  describeValue,
  isRenderableString,
  isUsableName,
  maskValue,
  rate,
  renderReport,
  sanitize,
} from '../src/index.mjs'
import { reportFor, ruleIds } from './helpers.mjs'

const CLASSES = Object.freeze([
  ['C0', String.fromCharCode(0x01)],
  ['C0 newline', String.fromCharCode(0x0a)],
  ['DEL', String.fromCharCode(0x7f)],
  ['C1 NEL', String.fromCharCode(0x85)],
  ['C1 CSI', String.fromCharCode(0x9b)],
  ['line separator', String.fromCharCode(0x2028)],
  ['paragraph separator', String.fromCharCode(0x2029)],
  ['bidi mark', String.fromCharCode(0x200e)],
  ['bidi override', String.fromCharCode(0x202e)],
  ['bidi isolate', String.fromCharCode(0x2066)],
])

const UNSAFE = new RegExp(`[\\p{Cc}\\p{Cf}${LINE_SEPARATORS}]`, 'u')

test('every unsafe class is removed from a sanitised string', () => {
  for (const [name, character] of CLASSES) {
    const cleaned = sanitize(`before${character}after`)
    assert.equal(UNSAFE.test(cleaned), false, name)
    assert.equal(cleaned, 'before after', name)
  }
})

test('a string of nothing but unsafe characters renders empty, and is not a usable name', () => {
  for (const [name, character] of CLASSES) {
    assert.equal(sanitize(character.repeat(4)), '', name)
    // `value.trim().length > 0` is true for most of these, which is exactly the
    // gap that shipped as a bug: the question has to be asked of the RENDERED
    // form.
    assert.equal(isRenderableString(character.repeat(4)), false, name)
    assert.equal(isUsableName(character.repeat(4)), false, name)
  }
})

test('a name that merely survives sanitising is still refused, because it would collide', () => {
  const forged = `a${String.fromCharCode(0x01)}b`
  assert.equal(sanitize(forged), 'a b')
  assert.equal(isRenderableString(forged), true)
  assert.equal(isUsableName(forged), false)
  assert.equal(isUsableName('a b'), true)
  assert.equal(isUsableName('a'.repeat(MAX_PATH_LENGTH)), true)
  assert.equal(isUsableName('a'.repeat(MAX_PATH_LENGTH + 1)), false)
})

test('an unsafe character arriving through a field NAME never reaches the report', () => {
  for (const [name, character] of CLASSES) {
    const report = reportFor([{ [`field${character}name`]: 'ada@example.test', plain: 'x' }])
    assert.deepEqual(report.fields.map((entry) => entry.path), ['plain'], name)
    assert.ok(ruleIds(report).includes('field-path-unusable'), name)
    assert.equal(UNSAFE.test(JSON.stringify(report)), false, name)
  }
})

test('an unsafe character arriving through a VALUE becomes a mask, never a line break', () => {
  for (const [name, character] of CLASSES) {
    const report = reportFor([{ note: `ada${character}@example.test` }])
    assert.equal(UNSAFE.test(JSON.stringify(report)), false, name)
    assert.equal(report.fields[0].values.examined, 1, name)
  }
  // Pin the masks themselves: an absence assertion alone is satisfied by an
  // empty report. A format character is removed before recognition, because it
  // is how an address hides from a pattern while still reaching a person's eye.
  assert.equal(maskValue(`ada${String.fromCharCode(0x200e)}@example.test`), 'xxx@xxxxxxx.xxxx')
  // A control character is not removed before recognition -- it is not an
  // invisible formatting mark, it is a different value -- so it shows as `?`.
  assert.equal(maskValue(`ada${String.fromCharCode(0x01)}@example.test`), 'xxx?@xxxxxxx.xxxx')
})

test('the dataset name reaches the report sanitised', () => {
  const report = reportFor([{ a: 'x' }])
  assert.equal(report.dataset.name, 'test-export')
  assert.equal(sanitize(`a${String.fromCharCode(0x9b)}b`), 'a b')
})

test('a value that cannot be converted to a primitive is described, never thrown over', () => {
  // `{"id": {"toString": {}}}` parses into exactly this, and `String(value)`
  // throws "Cannot convert object to primitive value" on it.
  const hostile = { toString: {} }
  assert.throws(() => `${hostile}`, TypeError)
  assert.equal(describeValue(hostile), '[object]')
  assert.equal(sanitize(hostile), '[object]')
  assert.equal(describeValue([1, 2]), '[array]')
  assert.equal(describeValue(null), 'null')
})

test('the two separators are escaped on the way out as well as stripped on the way in', () => {
  // Belt and braces: nothing upstream can put one here any more, which is
  // precisely why it is the kind of guarantee that quietly stops being true.
  const forged = {
    schemaVersion: '1',
    tool: 'pii-discovery-report',
    status: 'pass',
    summary: {},
    fields: [{ path: `a${String.fromCharCode(0x2028)}b` }],
    findings: [],
  }
  const rendered = renderReport(forged)
  assert.equal(rendered.includes(String.fromCharCode(0x2028)), false)
  assert.ok(rendered.includes('a\\u2028b'))
  assert.deepEqual(JSON.parse(rendered).fields[0].path, `a${String.fromCharCode(0x2028)}b`)
})

test('sanitising bounds the length and marks what it cut', () => {
  assert.equal(sanitize('x'.repeat(200)), 'x'.repeat(200))
  assert.equal(sanitize('x'.repeat(201)), `${'x'.repeat(197)}...`)
})

test('rounding a report number never turns something into nothing', () => {
  // `matched: 1` beside `matchRate: 0` is two numbers disagreeing about the
  // same evidence, and one match in two hundred thousand values rounds to zero.
  assert.equal(rate(1, 200000), 1 / 200000)
  assert.equal(rate(1, 4), 0.25)
  assert.equal(rate(1, 3), 0.3333)
  assert.equal(rate(0, 10), 0)
  assert.equal(rate(1, 0), 0)
  assert.equal(rate(0, 0), 0)
  // Every number a report carries comes from `rate` or from `String(...)` on a
  // count. There is no second number formatter: `num` used to live beside this
  // one, exported and tested and called from nowhere, which is the shape a
  // reader greps, finds, and stops looking at.
  assert.equal(Object.keys(text).filter((name) => name === 'num').length, 0)
})
