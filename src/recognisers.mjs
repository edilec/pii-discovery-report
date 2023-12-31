/**
 * The recogniser catalog and the confidence scale.
 *
 * Every recogniser here answers a question about SHAPE. A value shaped like an
 * electronic mail address is not the same fact as an address that reaches a
 * person, and no amount of pattern matching closes that gap -- so each
 * recogniser declares the BASIS of its evidence, the report carries that basis
 * beside every candidate, and a basis that is only the name of the field can
 * never reach high confidence however many rows agree with it.
 *
 * Two design decisions cost recall on purpose, and both are documented as
 * limits rather than hidden:
 *
 * 1. A recogniser matches a WHOLE value, never a substring. An address quoted
 *    inside a free-text note is not found. Scanning prose for embedded
 *    identifiers is how a checker starts reporting defects on correct input,
 *    and a false positive at error severity is the worst defect this kind of
 *    tool can have: a miss leaves the reader where they were, a false positive
 *    sends somebody to redact a product code.
 * 2. `phone-number` requires an international prefix or a grouped national
 *    form. A bare run of ten digits is an order number as often as it is a
 *    telephone number, and this tool does not guess between them.
 */

/** Ordered weakest to strongest. Comparisons use the index, never the string. */
export const CONFIDENCE_ORDER = Object.freeze(['low', 'medium', 'high'])

export function confidenceRank(confidence) {
  const rank = CONFIDENCE_ORDER.indexOf(confidence)
  if (rank < 0) throw new Error(`Unknown confidence "${confidence}"`)
  return rank
}

/**
 * The confidence thresholds, declared once.
 *
 * Both sides of each of these is observable and both are pinned by tests: a
 * match rate of exactly HIGH_RATE over exactly HIGH_MIN_EVIDENCE values is
 * high, and one value less or one hundredth lower is not.
 */
export const HIGH_RATE = 0.9
export const HIGH_MIN_EVIDENCE = 4
export const MEDIUM_RATE = 0.5
export const MEDIUM_MIN_EVIDENCE = 2
export const CHECKSUM_RATE = 0.5
export const CHECKSUM_MIN_EVIDENCE = 2

/** How many masked examples a field entry may carry. */
export const MAX_MASKED_EXAMPLES = 3
export const MASK_LIMIT = 48

/**
 * Structural characters a mask keeps.
 *
 * The mask shows SHAPE and nothing else: every digit becomes `#`, every letter
 * becomes `x`, these separators survive, and anything else -- whitespace, a
 * control character, an emoji, a format character -- becomes `?`. No character
 * of the original value that could carry identity survives, which is what makes
 * it safe to print a masked example beside a finding.
 */
const STRUCTURAL = new Set(['@', '.', '-', '+', '(', ')', '/', ':', ','])

const FORMAT_CHARACTERS = /\p{Cf}/gu

/**
 * The form a recogniser sees.
 *
 * Invisible format characters are removed first. They are how an identifier
 * hides from a pattern while still reaching a person's eye, and removing them
 * cannot turn a value that is not an address into one.
 */
export function normaliseValue(value) {
  return value.replace(FORMAT_CHARACTERS, '').trim()
}

export function maskValue(value) {
  const normalised = normaliseValue(value)
  let masked = ''
  for (const character of normalised) {
    if (masked.length >= MASK_LIMIT) return `${masked}...`
    if (character >= '0' && character <= '9') masked += '#'
    else if (STRUCTURAL.has(character)) masked += character
    else if (/\p{L}/u.test(character)) masked += 'x'
    else masked += '?'
  }
  return masked
}

/**
 * Column names that declare a reading a dotted quad ALSO has.
 *
 * `1.2.3.4` is a legal IPv4 address and a legal four-part build number, and
 * nothing inside the value separates the two: every octet is under 256 and none
 * is padded, which is exactly what a build number looks like. Reporting such a
 * column as a network identifier at error severity is a finding on correct
 * input -- the worst defect this kind of tool can have -- and it was reported
 * against this tool on the column `app_version`.
 *
 * What separates the readings is the name the exporter gave the column, which
 * this tool already treats as evidence in the other direction: a date in
 * `shipped_on` is a date and not a birth date. So a name that declares a
 * version refuses the network reading, and a name that declares BOTH -- say
 * `build_server_ip` -- refuses nothing, because the network token is the more
 * specific statement about what the column holds.
 *
 * This is a deliberate loss of recall, in the same trade as whole-value
 * matching: a column of real addresses named `firmware_version` is missed. The
 * README names it beside the other losses rather than hiding it.
 */
const VERSION_NAME_TOKENS = new Set(['version', 'build', 'revision', 'release', 'firmware', 'semver'])
const NETWORK_NAME_TOKENS = new Set([
  'ip', 'ipv4', 'ipv6', 'addr', 'address', 'host', 'hostname', 'gateway', 'subnet', 'netmask', 'cidr',
])

/** The words in a column name: anything that is not a letter or a digit separates them. */
function nameTokens(name) {
  return name.split(/[^a-z0-9]+/u).filter((token) => token !== '')
}

function declaresVersionAndNotNetwork(name) {
  const tokens = nameTokens(name)
  return (
    tokens.some((token) => VERSION_NAME_TOKENS.has(token))
    && !tokens.some((token) => NETWORK_NAME_TOKENS.has(token))
  )
}

/** The field name a name-based recogniser is asked about: the last path segment. */
export function fieldNameOf(path) {
  const segments = path.split('.')
  const last = segments[segments.length - 1] ?? path
  return last.replace(/\[\]$/u, '').toLowerCase()
}

const EMAIL = /^[^\s@,;<>"'\\]{1,64}@(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}$/iu
const PHONE_INTERNATIONAL = /^\+[0-9][0-9 .()-]{6,20}$/u
const PHONE_GROUPED = /^\(?[0-9]{3}\)?[ .-][0-9]{3}[ .-][0-9]{4}$/u
const CARD_SHAPE = /^[0-9][0-9 -]{11,21}[0-9]$/u
const GOVERNMENT_ID = /^[0-9]{3}-[0-9]{2}-[0-9]{4}$/u
const IPV4 = /^(?:[0-9]{1,3}\.){3}[0-9]{1,3}$/u
const IPV6_CHARACTERS = /^[0-9a-f:]{2,45}$/iu
const IPV6_GROUP = /^[0-9a-f]{1,4}$/iu
const ISO_DATE = /^([0-9]{4})-([0-9]{2})-([0-9]{2})$/u
const CIVIL_DATE = /^([0-9]{1,2})[/.-]([0-9]{1,2})[/.-]([0-9]{4})$/u

function digitsOf(value) {
  let digits = ''
  for (const character of value) if (character >= '0' && character <= '9') digits += character
  return digits
}

/** The Luhn check digit. It is what keeps `payment-card` off ordinary numbers. */
export function luhnValid(digits) {
  if (digits.length < 13 || digits.length > 19) return false
  let sum = 0
  let double = false
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    let value = digits.charCodeAt(index) - 48
    if (double) {
      value *= 2
      if (value > 9) value -= 9
    }
    sum += value
    double = !double
  }
  return sum % 10 === 0
}

/**
 * The issuer identification numbers a payment card can carry.
 *
 * A Luhn check alone is not a card number. Luhn accepts one digit string in ten
 * whatever its length, so a column of internal references draws a payment-card
 * candidate by chance: twelve sixteen-digit order numbers produced two matches
 * here and turned a clean run into `incomplete` at exit 2, which is a finding on
 * correct input.
 *
 * What separates a primary account number from any other run of digits is its
 * ISSUER IDENTIFICATION NUMBER. ISO/IEC 7812-1 assigns the leading digits to an
 * issuer, and each card network publishes the prefix ranges and the lengths it
 * issues; a number outside every one of them was not issued as a payment card.
 *
 * Each row is a prefix range compared digit for digit across the same number of
 * leading digits, with the lengths that network issues. The table is
 * deliberately conservative -- a card from a network not listed here is missed,
 * which is the same trade as whole-value matching -- and it is the only claim in
 * this file that rests on a fact outside the value, so the row it comes from is
 * named beside it.
 */
const CARD_LENGTHS_12_TO_19 = Object.freeze([12, 13, 14, 15, 16, 17, 18, 19])
const CARD_LENGTHS_16_TO_19 = Object.freeze([16, 17, 18, 19])

const CARD_RANGES = Object.freeze([
  // American Express
  Object.freeze({ from: '34', to: '34', lengths: Object.freeze([15]) }),
  Object.freeze({ from: '37', to: '37', lengths: Object.freeze([15]) }),
  // Diners Club
  Object.freeze({ from: '300', to: '305', lengths: Object.freeze([14]) }),
  Object.freeze({ from: '3095', to: '3095', lengths: Object.freeze([14]) }),
  Object.freeze({ from: '36', to: '36', lengths: Object.freeze([14]) }),
  Object.freeze({ from: '38', to: '39', lengths: Object.freeze([14]) }),
  // JCB
  Object.freeze({ from: '3528', to: '3589', lengths: CARD_LENGTHS_16_TO_19 }),
  // Visa
  Object.freeze({ from: '4', to: '4', lengths: Object.freeze([13, 16, 19]) }),
  // Maestro
  Object.freeze({ from: '50', to: '50', lengths: CARD_LENGTHS_12_TO_19 }),
  Object.freeze({ from: '56', to: '58', lengths: CARD_LENGTHS_12_TO_19 }),
  Object.freeze({ from: '639', to: '639', lengths: CARD_LENGTHS_12_TO_19 }),
  Object.freeze({ from: '67', to: '67', lengths: CARD_LENGTHS_12_TO_19 }),
  // Mastercard
  Object.freeze({ from: '51', to: '55', lengths: Object.freeze([16]) }),
  Object.freeze({ from: '2221', to: '2720', lengths: Object.freeze([16]) }),
  // UnionPay
  Object.freeze({ from: '62', to: '62', lengths: CARD_LENGTHS_16_TO_19 }),
  // Discover
  Object.freeze({ from: '6011', to: '6011', lengths: Object.freeze([16, 19]) }),
  Object.freeze({ from: '644', to: '649', lengths: Object.freeze([16, 19]) }),
  Object.freeze({ from: '65', to: '65', lengths: Object.freeze([16, 19]) }),
])

/** Whether these digits could have been issued by one of the networks above. */
export function issuedRange(digits) {
  for (const range of CARD_RANGES) {
    if (!range.lengths.includes(digits.length)) continue
    // Both sides are the same number of digit characters, so a code-unit
    // comparison is a numeric comparison.
    const prefix = digits.slice(0, range.from.length)
    if (prefix >= range.from && prefix <= range.to) return true
  }
  return false
}

function phoneMatches(value) {
  if (PHONE_INTERNATIONAL.test(value)) {
    const digits = digitsOf(value).length
    return digits >= 8 && digits <= 15
  }
  return PHONE_GROUPED.test(value)
}

/**
 * IPv6, checked by structure rather than by character set.
 *
 * A character-class pattern that merely allows empty groups accepts `:::`,
 * which is not an address at all: the compression marker is exactly one `::`,
 * and it stands for at least one omitted group, so the groups on either side of
 * it can number at most seven.
 */
function ipv6Matches(value) {
  if (!IPV6_CHARACTERS.test(value) || value.includes(':::')) return false
  const halves = value.split('::')
  if (halves.length > 2) return false
  const groupsOf = (part) => (part === '' ? [] : part.split(':'))
  const wellFormed = (group) => IPV6_GROUP.test(group)
  if (halves.length === 2) {
    const head = groupsOf(halves[0])
    const tail = groupsOf(halves[1])
    return head.every(wellFormed) && tail.every(wellFormed) && head.length + tail.length <= 7
  }
  const groups = value.split(':')
  return groups.length === 8 && groups.every(wellFormed)
}

function ipMatches(value) {
  if (IPV4.test(value)) {
    // A padded octet is not the octet it looks like -- `203.00.113.42` is
    // rejected by every parser that follows the specification, and treating it
    // as an address would be this tool inventing a reading.
    return value
      .split('.')
      .every((part) => Number(part) <= 255 && !(part.length > 1 && part[0] === '0'))
  }
  return ipv6Matches(value)
}

function dateShape(value) {
  const iso = ISO_DATE.exec(value)
  if (iso !== null) {
    const month = Number(iso[2])
    const day = Number(iso[3])
    return month >= 1 && month <= 12 && day >= 1 && day <= 31
  }
  const civil = CIVIL_DATE.exec(value)
  if (civil === null) return false
  const first = Number(civil[1])
  const second = Number(civil[2])
  // Either ordering of day and month is accepted: which one a column uses is
  // not recorded in the value, and guessing would be an invention.
  return first >= 1 && first <= 31 && second >= 1 && second <= 31 && (first <= 12 || second <= 12)
}

/**
 * Column names that say the column holds people's names.
 *
 * A bare `name` is deliberately NOT one of them. It is one of the most common
 * column names there is and it names a product, a place, a file or a queue as
 * often as a person, so matching it made an ordinary catalogue `uncertain` and
 * ended a correct run at exit 2 -- noise on correct input, from the one
 * recogniser that classifies no value and so can never be confirmed by one.
 * `surname` and `forename` stay: neither names anything but a person.
 *
 * The cost is a column named exactly `name` that does hold people's names,
 * which is reported `clean`. It is in the README beside the other recall this
 * design trades away, with the two ways to recover it: name the column for what
 * it holds, or acknowledge it in the configuration.
 */
const PERSON_NAME_FIELD =
  /^(?:first|last|given|family|middle|full|contact|customer|employee|patient|user)_?name$|^(?:surname|forename)$/u
const BIRTH_FIELD = /^(?:dob|date_of_birth|birth_date|birthdate|birthday|born_on)$/u

/**
 * The catalog.
 *
 * `basis` is reported with every candidate because it is what a reader needs in
 * order to judge the finding:
 *
 *   value-pattern-checksum  the value carries its own check digit
 *   value-pattern           the value has a distinctive shape
 *   field-name-and-value    the field is named for a category and the values
 *                           have the shape that category takes
 *   field-name              only the name of the field suggests the category;
 *                           no value was classified at all
 */
export const RECOGNISERS = Object.freeze([
  Object.freeze({
    id: 'email-address',
    category: 'email',
    basis: 'value-pattern',
    maxConfidence: 'high',
    checksum: false,
    matchesName: null,
    refusedByName: null,
    matchesValue: (value) => EMAIL.test(value),
  }),
  Object.freeze({
    id: 'payment-card',
    category: 'payment-card',
    basis: 'value-pattern-checksum',
    maxConfidence: 'high',
    checksum: true,
    matchesName: null,
    refusedByName: null,
    matchesValue: (value) => {
      if (!CARD_SHAPE.test(value)) return false
      const digits = digitsOf(value)
      return issuedRange(digits) && luhnValid(digits)
    },
  }),
  Object.freeze({
    id: 'phone-number',
    category: 'phone',
    basis: 'value-pattern',
    maxConfidence: 'high',
    checksum: false,
    matchesName: null,
    refusedByName: null,
    matchesValue: phoneMatches,
  }),
  Object.freeze({
    id: 'government-id',
    category: 'government-id',
    basis: 'value-pattern',
    maxConfidence: 'high',
    checksum: false,
    matchesName: null,
    refusedByName: null,
    matchesValue: (value) => GOVERNMENT_ID.test(value),
  }),
  Object.freeze({
    id: 'network-address',
    category: 'network-identifier',
    basis: 'value-pattern',
    maxConfidence: 'high',
    checksum: false,
    matchesName: null,
    // The one recogniser whose value shape belongs to something else as well.
    refusedByName: declaresVersionAndNotNetwork,
    matchesValue: ipMatches,
  }),
  Object.freeze({
    id: 'date-of-birth',
    category: 'date-of-birth',
    basis: 'field-name-and-value',
    // A date is a date. That this one is a birth date is said by the column
    // name alone, which is an author's label and not evidence about the value,
    // so this recogniser is capped below the value-only ones however many rows
    // agree.
    maxConfidence: 'medium',
    checksum: false,
    matchesName: (name) => BIRTH_FIELD.test(name),
    refusedByName: null,
    matchesValue: dateShape,
  }),
  Object.freeze({
    id: 'person-name',
    category: 'person-name',
    basis: 'field-name',
    // Nothing about the characters in a personal name distinguishes it from a
    // place, a product or a pseudonym. This recogniser classifies NO value: it
    // reports that the column is named for people, at the lowest confidence the
    // scale has, and says in the report that the values were not classified.
    maxConfidence: 'low',
    checksum: false,
    matchesName: (name) => PERSON_NAME_FIELD.test(name),
    refusedByName: null,
    matchesValue: null,
  }),
])

export const RECOGNISER_IDS = Object.freeze(RECOGNISERS.map((recogniser) => recogniser.id))
export const CATEGORIES = Object.freeze([...new Set(RECOGNISERS.map((r) => r.category))])

export function recogniserById(id) {
  return RECOGNISERS.find((recogniser) => recogniser.id === id) ?? null
}

function cap(confidence, maximum) {
  return confidenceRank(confidence) > confidenceRank(maximum) ? maximum : confidence
}

/**
 * Confidence for one recogniser over one field.
 *
 * A field-name basis never consults a rate, because there is no rate to
 * consult: no value was classified, and dressing that up with a number would
 * invent evidence.
 */
export function confidenceFor(recogniser, matched, evaluated) {
  if (recogniser.matchesValue === null) return recogniser.maxConfidence
  if (matched <= 0 || evaluated <= 0) return 'low'
  const matchRate = matched / evaluated
  let confidence = 'low'
  if (matchRate >= MEDIUM_RATE && evaluated >= MEDIUM_MIN_EVIDENCE) confidence = 'medium'
  if (matchRate >= HIGH_RATE && evaluated >= HIGH_MIN_EVIDENCE) confidence = 'high'
  if (recogniser.checksum && matchRate >= CHECKSUM_RATE && evaluated >= CHECKSUM_MIN_EVIDENCE) {
    confidence = 'high'
  }
  return cap(confidence, recogniser.maxConfidence)
}
