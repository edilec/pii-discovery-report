/**
 * The good case first.
 *
 * The first verification of a checker is not "does it catch the bad case". It
 * is "does it stay silent on the good one": a miss leaves the reader where they
 * were, a false positive at error severity sends somebody to redact a product
 * code, and after that nobody reads the output. Every recogniser below is
 * tested against the near-misses that would make it noisy before it is tested
 * against the value it exists to find.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { RECOGNISERS, issuedRange, luhnValid, normaliseValue, recogniserById } from '../src/index.mjs'
import { fieldNamed, reportFor } from './helpers.mjs'

function matches(id, value) {
  const recogniser = recogniserById(id)
  return recogniser.matchesValue !== null && recogniser.matchesValue(normaliseValue(value))
}

test('an ordinary business export draws no candidate at all', () => {
  const report = reportFor([
    {
      order_ref: 'ORD-2026-000813',
      product_name: 'Hex Bolt M8',
      sku: '4901234512345',
      unit_price: 12.5,
      quantity: 40,
      warehouse_code: 'LDN-03',
      created_at: '2026-02-14T09:15:00Z',
      version: '2.14.0',
      in_stock: true,
      supplier: { company_name: 'Northwind Fixings Ltd' },
      notes: 'Call before delivery on 0800 numbers',
    },
  ])
  assert.deepEqual(report.findings, [])
  assert.equal(report.status, 'pass')
  assert.equal(report.summary.clean, 11)
  assert.equal(report.summary.personalData, 0)
  assert.equal(report.summary.uncertain, 0)
})

test('email-address: the near-misses first', () => {
  for (const value of ['a@b', 'ada example.test', '@example.test', 'ada@', 'ada@example', 'ada @example.test']) {
    assert.equal(matches('email-address', value), false, value)
  }
  assert.equal(matches('email-address', 'ada@example.test'), true)
  assert.equal(matches('email-address', 'ada.lovelace+notes@mail.example.test'), true)
})

test('a four-part build number is not a network address, and the run stays at exit 0', () => {
  // The defect this pins: every one of these values is a legal dotted quad, so
  // the column was classified network-identifier at HIGH confidence and raised
  // `personal-data-detected` at ERROR severity -- a finding on correct input.
  const versions = ['1.2.3.4', '2.0.0.1', '10.4.0.2', '11.0.1.3', '9.8.7.6', '1.0.0.0']
  const report = reportFor(versions.map((value) => ({ app_version: value, rollout: 'stable' })))
  assert.deepEqual(report.findings, [])
  assert.equal(report.status, 'pass')
  assert.equal(fieldNamed(report, 'app_version').classification, 'clean')
  assert.deepEqual(fieldNamed(report, 'app_version').candidates, [])
  // The refusal is the COLUMN NAME's, not the value pattern's: the same value
  // in a column that does not claim to hold a version is still an address.
  assert.equal(matches('network-address', '1.2.3.4'), true)
  assert.equal(fieldNamed(reportFor(versions.map((v) => ({ source: v }))), 'source').classification, 'personal-data')
})

test('a name that says version AND says network refuses nothing', () => {
  const addresses = ['203.0.113.42', '198.51.100.7', '192.0.2.9', '203.0.113.5']
  const report = reportFor(addresses.map((value) => ({
    last_seen_ip: value,
    build_server_ip: value,
    firmware_version: value,
  })))
  for (const path of ['last_seen_ip', 'build_server_ip']) {
    const entry = fieldNamed(report, path)
    assert.equal(entry.classification, 'personal-data', path)
    assert.equal(entry.category, 'network-identifier', path)
    assert.equal(entry.confidence, 'high', path)
  }
  // The documented cost of the refusal, pinned so that it is a decision and not
  // a surprise: a column of real addresses named for firmware is missed.
  assert.equal(fieldNamed(report, 'firmware_version').classification, 'clean')
})

test('a recogniser matches a whole value, never a fragment of prose', () => {
  // Documented as a limit rather than hidden: scanning prose for embedded
  // identifiers is how a checker starts reporting defects on correct input.
  assert.equal(matches('email-address', 'write to ada@example.test about it'), false)
  const report = reportFor([{ notes: 'write to ada@example.test about it' }])
  assert.equal(fieldNamed(report, 'notes').classification, 'clean')
})

test('phone-number: a bare run of digits is not a telephone number', () => {
  // An order number as often as a telephone number, and this tool does not
  // guess between them. The cost is recall on unformatted columns, and it is in
  // the README under limits.
  for (const value of ['4155550143', '12345', '2026', '415 5550143']) {
    assert.equal(matches('phone-number', value), false, value)
  }
  for (const value of ['+44 20 7946 0958', '+1 (415) 555-0143', '(415) 555-0181', '415.555.0181']) {
    assert.equal(matches('phone-number', value), true, value)
  }
  // Too few and too many digits, on both sides of the international bound.
  assert.equal(matches('phone-number', '+1 234 567'), false)
  assert.equal(matches('phone-number', '+1 234 5678'), true)
  assert.equal(matches('phone-number', '+123 456 789 012 345'), true)
  assert.equal(matches('phone-number', '+123 456 789 012 3456'), false)
})

test('payment-card: the check digit is what keeps it off ordinary numbers', () => {
  assert.equal(matches('payment-card', '4111 1111 1111 1111'), true)
  assert.equal(matches('payment-card', '4111-1111-1111-1111'), true)
  // One digit changed: the shape is identical and the checksum is not.
  assert.equal(matches('payment-card', '4111 1111 1111 1112'), false)
  assert.equal(matches('payment-card', '4901234512345'), false)
  assert.equal(matches('payment-card', '123456789012'), false)
})

test('payment-card: a column of internal order numbers is not a card column', () => {
  // The defect this pins. Luhn accepts one digit string in ten whatever the
  // length, so two of these twelve references passed it by chance, the field
  // became `uncertain`, and a clean run ended `incomplete` at exit 2. Both of
  // the two are named here so the case cannot quietly stop being the case.
  const orders = Array.from({ length: 12 }, (unused, index) => `88${String(1000001 + index).padStart(14, '0')}`)
  assert.equal(luhnValid('8800000001000004'), true)
  assert.equal(luhnValid('8800000001000012'), true)
  assert.equal(matches('payment-card', '8800000001000004'), false)
  const report = reportFor(orders.map((order_number) => ({ order_number })))
  assert.deepEqual(report.findings, [])
  assert.equal(report.status, 'pass')
  assert.equal(fieldNamed(report, 'order_number').classification, 'clean')
})

test('payment-card: every published network test number still matches', () => {
  // The recall side of the same guard. These are the numbers the networks
  // publish for testing; they belong to nobody and they are what the narrowing
  // must not cost.
  for (const value of [
    '4111 1111 1111 1111', '4012 8888 8888 1881', '4222222222222',
    '5555 5555 5555 4444', '5105 1051 0510 5100', '2223003122003222',
    '378282246310005', '371449635398431',
    '30569309025904', '38520000023237',
    '3530111333300000', '6011111111111117', '6759649826438453',
  ]) {
    assert.equal(matches('payment-card', value), true, value)
  }
})

test('payment-card: the issuer table is what the measured chance rate rests on', () => {
  // Re-derived rather than asserted: every four-digit prefix is enumerated, so
  // widening the table by one range changes this number and the README's
  // measured rate with it. Four digits is exact -- no range in the table is
  // longer than four.
  const prefixesAtLength = (length) => {
    let hits = 0
    for (let prefix = 0; prefix < 10000; prefix += 1) {
      if (issuedRange(String(prefix).padStart(4, '0') + '0'.repeat(length - 4))) hits += 1
    }
    return hits
  }
  assert.equal(prefixesAtLength(16), 2833)
  assert.equal(prefixesAtLength(15), 710)
  // A Luhn check passes one uniformly random digit string in ten, so a
  // sixteen-digit reference reaches `payment-card` by chance at 0.2833 / 10.
  assert.equal(Math.round((2833 / 10000 / 10) * 100000) / 100000, 0.02833)
})

test('government-id: only the grouped shape, and it collides with internal references by design', () => {
  assert.equal(matches('government-id', '987-00-4320'), true)
  assert.equal(matches('government-id', '987654320'), false)
  assert.equal(matches('government-id', '1984-03-11'), false)
  // The known false-positive class, stated rather than wished away: an internal
  // reference in the same shape is indistinguishable from an identifier.
  assert.equal(matches('government-id', '412-00-7731'), true)
})

test('network-address: an octet out of range or padded is not an address', () => {
  assert.equal(matches('network-address', '203.0.113.42'), true)
  assert.equal(matches('network-address', '198.51.100.7'), true)
  assert.equal(matches('network-address', '255.255.255.255'), true)
  assert.equal(matches('network-address', '256.0.113.42'), false)
  assert.equal(matches('network-address', '203.0.113'), false)
  assert.equal(matches('network-address', '203.00.113.42'), false)
  assert.equal(matches('network-address', '2.14.0'), false)
  assert.equal(matches('network-address', '2001:db8::7334'), true)
  assert.equal(matches('network-address', '2001:db8:::7334'), false)
  assert.equal(matches('network-address', '2001:db8:0:0:0:0:0:1'), true)
  assert.equal(matches('network-address', '2001:db8:0:0:0:0:0:0:1'), false)
  assert.equal(matches('network-address', '::1'), true)
  assert.equal(matches('network-address', ':'), false)
  // The compression marker stands for at least one omitted group, so seven
  // groups beside it is legal and eight is not.
  assert.equal(matches('network-address', '1:2:3:4:5:6:7::'), true)
  assert.equal(matches('network-address', '1:2:3:4:5:6:7:8::'), false)
})

test('date-of-birth: a date is only a birth date when the column says so', () => {
  const inBirthColumn = reportFor([
    { date_of_birth: '1984-03-11' }, { date_of_birth: '1991-07-02' },
    { date_of_birth: '1978-12-24' }, { date_of_birth: '2001-01-30' },
  ])
  assert.equal(fieldNamed(inBirthColumn, 'date_of_birth').classification, 'personal-data')
  assert.equal(fieldNamed(inBirthColumn, 'date_of_birth').confidence, 'medium')

  const elsewhere = reportFor([
    { shipped_on: '1984-03-11' }, { shipped_on: '1991-07-02' },
    { shipped_on: '1978-12-24' }, { shipped_on: '2001-01-30' },
  ])
  assert.equal(fieldNamed(elsewhere, 'shipped_on').classification, 'clean')
  assert.deepEqual(elsewhere.findings, [])

  // Named for birth, holding something that is not a date: no candidate, so no
  // finding. The column name alone is not evidence about a value.
  const namedOnly = reportFor([{ birth_date: 'unknown' }, { birth_date: 'n/a' }])
  assert.equal(fieldNamed(namedOnly, 'birth_date').classification, 'clean')
})

test('person-name: found by the column name, and it says no value was classified', () => {
  const report = reportFor([{ full_name: 'Avery Stone' }, { full_name: 'Jide Okafor' }], { minConfidence: 'low' })
  const entry = fieldNamed(report, 'full_name')
  assert.equal(entry.classification, 'personal-data')
  assert.equal(entry.confidence, 'low')
  assert.equal(entry.candidates[0].valuesClassified, false)
  assert.equal(entry.candidates[0].matched, 0)
  assert.equal(entry.candidates[0].examined, 0)

  // The qualifiers are what keep it off the columns that merely end in "name".
  for (const key of ['product_name', 'company_name', 'file_name', 'column_name', 'event_name']) {
    const quiet = reportFor([{ [key]: 'Anything At All' }], { minConfidence: 'low' })
    assert.equal(fieldNamed(quiet, key).classification, 'clean', key)
  }
})

test('person-name: a bare "name" column is not a person name, in either direction', () => {
  // The defect this pins: `name` drew a person-name candidate, the field became
  // `uncertain` at low confidence, and an ordinary product catalogue exited 2.
  const catalogue = reportFor(
    [{ name: 'Hex Bolt M8', sku: 'LDN-0001' }, { name: 'Cable Gland 20mm', sku: 'LDN-0002' }],
    { minConfidence: 'low' },
  )
  assert.deepEqual(catalogue.findings, [])
  assert.equal(catalogue.status, 'pass')
  assert.equal(fieldNamed(catalogue, 'name').classification, 'clean')

  // The names that say person and nothing else still do.
  for (const key of ['surname', 'forename', 'full_name', 'customer_name', 'patient_name']) {
    const found = reportFor([{ [key]: 'Avery Stone' }], { minConfidence: 'low' })
    assert.equal(fieldNamed(found, key).classification, 'personal-data', key)
    assert.equal(fieldNamed(found, key).category, 'person-name', key)
  }
})

test('a recogniser left out of the configuration takes its candidates with it', () => {
  const records = [
    { contact: 'ada@example.test' }, { contact: 'grace@example.test' },
    { contact: 'alan@example.test' }, { contact: 'edsger@example.test' },
  ]
  const withEmail = reportFor(records)
  assert.equal(fieldNamed(withEmail, 'contact').classification, 'personal-data')

  const withoutEmail = reportFor(records, { recognisers: ['payment-card', 'phone-number'] })
  assert.equal(fieldNamed(withoutEmail, 'contact').classification, 'clean')
  assert.deepEqual(withoutEmail.configuration.recognisers, ['payment-card', 'phone-number'])
  assert.equal(withoutEmail.status, 'pass')
})

test('every recogniser declares a basis, a category and a ceiling on its confidence', () => {
  assert.equal(RECOGNISERS.length, 7)
  for (const recogniser of RECOGNISERS) {
    assert.match(recogniser.id, /^[a-z][a-z0-9-]*$/u)
    assert.ok(['value-pattern', 'value-pattern-checksum', 'field-name-and-value', 'field-name'].includes(recogniser.basis))
    assert.ok(['low', 'medium', 'high'].includes(recogniser.maxConfidence))
    // A basis that involves the field name must have a name test, and one that
    // classifies values must have a value test. The two cannot drift apart.
    assert.equal(recogniser.basis.includes('field-name'), recogniser.matchesName !== null, recogniser.id)
    assert.equal(recogniser.basis === 'field-name', recogniser.matchesValue === null, recogniser.id)
  }
})
