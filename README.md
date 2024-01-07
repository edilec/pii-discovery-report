# pii-discovery-report

Run configured recognisers over a dataset somebody exported to a file, and report
which fields look like they hold personal data: the category, the basis of the
evidence, the confidence, the counts behind the confidence, and masked examples.

- **Repository:** [edilec/pii-discovery-report](https://github.com/edilec/pii-discovery-report)
- **Area:** Data & Analytics
- **License:** MIT

## Why it exists

Two things go wrong with tools in this shape, and both of them end with nobody
reading the output.

The first is **a finding on correct input**. A pattern loose enough to catch an
unformatted telephone column also catches every order number, and once a checker
has sent somebody to redact a product code twice, it is ignored. So every
recogniser here matches a **whole value**, `payment-card` carries a checksum, and
`phone-number` refuses a bare run of digits. That costs recall, and the cost is
written down under [Non-goals](#non-goals) and measured under
[What was measured](#what-was-measured) rather than hidden.

The second is **a quiet gap**. A report that says a field holds no personal data,
on a run that skipped a record it could not read, has told you something false in
the most reassuring possible way. So `clean` is the only word this tool uses that
makes a claim about absence, and it has the strictest precondition in the
program: every value in the field examined, and the whole dataset read. Anything
else is `undetermined` and the run is `incomplete`.

## Quick start

```sh
# A catalogue with nothing personal in it: every value examined, nothing matched.
node bin/pii-discovery-report.mjs --dataset examples/clean/dataset.json
# exit 0, status "pass"

# The seeded corpus: seven fields of invented personal data, twelve without.
node bin/pii-discovery-report.mjs \
  --dataset examples/seeded/dataset.json \
  --config examples/seeded/config.json
# exit 1, status "fail"

# A partial export: one record is not an object and one value is over the limit.
node bin/pii-discovery-report.mjs \
  --dataset examples/incomplete/dataset.json \
  --config examples/incomplete/config.json
# exit 2, status "incomplete" -- and every field reported as undetermined,
# because a record nobody read could have held anything.
```

`stdout` carries the JSON report and nothing else, so it pipes straight into a
parser. The human summary goes to `stderr`, and `--json` silences it.

## Input: the dataset document

```json
{
  "schemaVersion": "1",
  "dataset": "crm-orders-export-sample",
  "source": "tabular-export",
  "records": [
    { "order_ref": "ORD-2026-000813", "contact": { "email": "a@example.test" } }
  ]
}
```

- `source` must be `tabular-export` or `record-export`. Any other value is
  refused: a document written by an exporter this tool has never seen may put
  values anywhere, and reading it as though it were a known shape would produce
  field paths that do not exist.
- `records` is an array of JSON objects. Nested objects and arrays are walked;
  an array level shows in the path as `[]`, so `orders[].email` is one field.
- A key may legally contain the characters a path is composed from, so `\`, `.`,
  `[` and `]` inside a key are **escaped with a backslash**. A flat column
  literally named `contact.email` has the path `contact\.email` and the pointer
  `/contact\.email`; a nested `contact` holding `email` has the path
  `contact.email` and the pointer `/contact/email`. They are two fields, and
  without the escaping they were one entry with one merged match rate.
- A field path segment must print exactly as it is stored. A key containing a
  control character, a bidi mark or an irregular run of whitespace is counted as
  unexamined rather than printed wrong, because `a<U+0001>b` and `a b` print the
  same and are not the same field.

## Input: the configuration document

```json
{
  "schemaVersion": "1",
  "recognisers": ["email-address", "payment-card"],
  "minConfidence": "medium",
  "acknowledged": ["full_name"],
  "limits": { "maxRecords": 5000 }
}
```

Every key is optional except `schemaVersion`, and **an unknown key is refused**
rather than ignored: a one-character typo in a limit name must not turn a real
failure into a green run.

`acknowledged` lists field paths the operator has declared to hold personal data,
written in the composed form above -- acknowledging the flat column
`contact.email` is the JSON string `"contact\\.email"`, and `"contact.email"`
acknowledges the nested field.
That declaration settles the question in the direction of **presence** and never
in the direction of absence: an acknowledged field is reported as personal data
at `info` severity, and it still raises every finding about a value this run
could not examine.

## Recognisers

| Recogniser | Category | Basis | Ceiling | What it matches |
| --- | --- | --- | --- | --- |
| `email-address` | `email` | value-pattern | high | a whole value with a local part, `@`, and a dotted domain ending in 2-24 letters |
| `payment-card` | `payment-card` | value-pattern-checksum | high | digits with optional spaces or hyphens, carrying an issuer identification number a card network issues at that length, and passing the Luhn check |
| `phone-number` | `phone` | value-pattern | high | a `+` international form of 8-15 digits, or a grouped national form such as `(415) 555-0181` |
| `government-id` | `government-id` | value-pattern | high | three digits, two digits, four digits, hyphen separated |
| `network-address` | `network-identifier` | value-pattern | high | a dotted IPv4 quad with no padded octet, or a well-formed IPv6 address. **Refused by the column name** when the name says version and says nothing about a network: `1.2.3.4` is a legal address and a legal four-part build number, and the name is the only thing that separates them |
| `date-of-birth` | `date-of-birth` | field-name-and-value | medium | a date, in a column named for birth. A date is a date: that this one is a birth date is said by the column name, so it cannot reach high |
| `person-name` | `person-name` | field-name | low | a column named for people: `full_name`, `first_name`, `customer_name` and the rest of that family, plus `surname` and `forename`. A column named exactly `name` is **not** one of them. It classifies **no value**, says so in the report, and sits at the lowest confidence the scale has |

`basis` is reported beside every candidate, because it is what a reader needs in
order to judge the finding.

A column name is evidence in **both** directions. It can select a recogniser, as
it does for `date-of-birth` and `person-name`; and it can refuse one whose value
shape the name says belongs to something else. The refusal applies to
`network-address` alone, because a dotted quad is the only shape in this catalog
that another common kind of column takes in full. A name is read as declaring a
version when one of its words is `version`, `build`, `revision`, `release`,
`firmware` or `semver` and none of them is `ip`, `ipv4`, `ipv6`, `addr`,
`address`, `host`, `hostname`, `gateway`, `subnet`, `netmask` or `cidr` -- so
`app_version` refuses the reading and `build_server_ip` does not. The cost is a
column of real addresses named `firmware_version`, which is missed; that is the
same trade as whole-value matching, and it is listed under
[Non-goals](#non-goals).

A Luhn check on its own is not a card number: it accepts one uniformly random
digit string in ten, whatever the length, so a column of internal order numbers
draws a `payment-card` candidate by chance and an otherwise clean run ends
`incomplete`. So `payment-card` also requires an **issuer identification
number** (ISO/IEC 7812-1): the leading digits must fall in a range one of the
card networks issues, at a length that network issues. Enumerating every
four-digit prefix -- no range in the table is longer than four -- gives the
measured effect:

| Length | Prefixes a network issues | Reaching `payment-card` by chance |
| ---: | ---: | ---: |
| 16 | 2833 of 10000 | 0.02833, from 0.1 |
| 15 | 710 of 10000 | 0.00710, from 0.1 |

`test/recognisers.test.mjs` re-derives both counts from the table itself, so
widening it changes the test and this section together. The cost is a card from
a network the table does not list, which is missed; the networks it lists are
American Express, Diners Club, JCB, Visa, Maestro, Mastercard, UnionPay and
Discover.

## Confidence

| Confidence | Reached when |
| --- | --- |
| `high` | a match rate of 0.9 or more over at least 4 values examined; or, for a checksum recogniser, 0.5 or more over at least 2 |
| `medium` | a match rate of 0.5 or more over at least 2 values examined |
| `low` | anything else, and every field-name basis |

A recogniser never exceeds its own ceiling. `--min-confidence` (default `medium`)
sets the floor at which a candidate becomes a verdict.

## Classifications

| Classification | Meaning |
| --- | --- |
| `personal-data` | a candidate reached the floor, or the operator acknowledged the field |
| `uncertain` | a candidate was found below the floor. Not enough to name the category, not enough to call the field clean, so neither is reported |
| `undetermined` | at least one value was not examined, or the dataset was not read in full |
| `clean` | every value in this field was examined, the whole dataset was read, and no recogniser matched |

## What a field entry carries

```json
{
  "path": "contact.email",
  "pointer": "/contact/email",
  "classification": "personal-data",
  "category": "email",
  "categories": ["email"],
  "categoryCertain": true,
  "confidence": "high",
  "acknowledged": false,
  "values": { "examined": 12, "matched": 12, "unexamined": 0, "tooLong": 0, "notExact": 0, "notApplicable": 0 },
  "candidates": [
    { "recogniser": "email-address", "category": "email", "basis": "value-pattern",
      "confidence": "high", "matched": 12, "examined": 12, "matchRate": 1, "valuesClassified": true }
  ],
  "maskedExamples": ["x.xxxx@xxxxxxx.xxxx"]
}
```

- `values.matched` is the top candidate's match count; every candidate carries
  its own counts, so the confidence can be checked rather than trusted.
- `values.unexamined` is `tooLong + notExact`: values no recogniser saw. While it
  is above zero the field cannot be `clean`.
- `values.notApplicable` counts `true`, `false` and `null`. None of them can
  carry a category this tool recognises, so they do not make the field
  undetermined.
- `categoryCertain` answers a question about the CATEGORY and only matters when
  there is one. It is `false` when two categories reached the floor, or when the
  classification is `undetermined`; it is `true` for a `clean` field, where the
  question does not arise.
- `valuesClassified` is `false` for a candidate whose basis is the field name
  alone. It means exactly what it says: no value in the column was classified.

## Rules

| Rule | Severity | Raised when |
| --- | --- | --- |
| `classification-ambiguous` | warning | two categories reached the floor in one field. The presence is settled and the category is not; both are named |
| `classification-uncertain` | warning | a candidate sits below the floor |
| `dataset-invalid` | error | the document is not the shape this tool reads |
| `dataset-not-utf8` | error | the bytes are not valid UTF-8 |
| `dataset-source-unsupported` | error | the export shape is not one this tool reads |
| `dataset-too-large` | error | the file is over `maxDatasetBytes` |
| `dataset-unparsable` | error | the file is not valid JSON |
| `dataset-unreadable` | error | the file could not be opened |
| `field-limit-exceeded` | error | more distinct field paths than `maxFields`, so some values were not attributed |
| `field-path-unusable` | error | a key that prints as nothing, is over the path length, or would not print as it is stored |
| `no-fields-checked` | error | nothing was examined, so the run establishes nothing |
| `personal-data-acknowledged` | info | a field the configuration acknowledges |
| `personal-data-detected` | error | a field reached the floor and is not acknowledged |
| `record-invalid` | error | an entry in `records` is not a JSON object |
| `record-limit-exceeded` | error | more records than `maxRecords` |
| `record-too-deep` | error | a subtree deeper than `maxDepth` |
| `value-not-exactly-representable` | warning | a whole number outside the range a JSON reader keeps digit for digit |
| `value-too-long` | warning | a value longer than `maxValueLength` |

Every warning above appears in the unsettled set, so it produces `incomplete` and
exit 2 rather than a green run. `classification-ambiguous` is deliberately not in
it: an open category is not an open detection.

## Exit codes

| Code | Meaning |
| ---: | --- |
| `0` | every field was examined in full, and no field that the configuration does not **acknowledge** reached the configured confidence. An acknowledged field is still reported as personal data, at `info` severity, and a run can exit 0 with fields classified `personal-data` at high confidence |
| `1` | the run completed and at least one unacknowledged field looks like personal data |
| `2` | invalid configuration, or evidence the run could not obtain |

Exit 2 has two shapes, and the difference matters to anything that pipes stdout:

| Situation | stdout | stderr |
| --- | --- | --- |
| invalid configuration, unknown option, bad usage | **empty** | the message |
| a dataset that could not be read, decoded or parsed, or a question left open | an `incomplete` report | optional diagnostics |

## Masking

No value from the dataset is ever printed. An example is a mask: every digit
becomes `#`, every letter becomes `x`, the separators `@ . - + ( ) / : ,` survive
and everything else becomes `?`. `alex.doe@example.test` reaches the report as
`xxxx.xxx@xxxxxxx.xxxx`, and a mask is capped at 48 characters.

## Limits

Each limit is enforced **before** the work it bounds. The file size is taken from
the file system before any byte is read; the record, field and depth bounds stop
the traversal rather than trimming its result; a value past `maxValueLength` is
left unexamined rather than shortened, so a cut value is never classified as
though it were whole; and `maxRecords * maxFields` is
checked against a cap of 2000000 field observations while the configuration is
validated, before a file is opened.

| Limit | Default | Ceiling |
| --- | ---: | ---: |
| `maxDatasetBytes` | 4194304 | 16777216 |
| `maxRecords` | 5000 | 200000 |
| `maxFields` | 256 | 4096 |
| `maxValueLength` | 4096 | 65536 |
| `maxDepth` | 8 | 32 |

Fixed, and not configurable: the configuration document itself is capped at 65536
bytes, `acknowledged` at 1024 entries, a field path segment at 128 characters, an
acknowledged path at 512, and a field entry keeps at most 3 masked examples.

Exceeding any limit is an `incomplete` result with a finding naming the limit.
It is never a silent truncation and never a pass.

## What was measured

On the corpus that ships in `examples/seeded/`, which carries 7 fields of invented
personal data and 12 fields without, at the default confidence floor:

| Measure | Count |
| --- | ---: |
| seeded personal-data fields classified `personal-data` | 7 of 7 |
| seeded personal-data fields missed | 0 |
| non-personal fields classified `personal-data` | 1 of 12 |
| non-personal fields drawing any candidate at all | 1 of 12 |
| non-personal fields drawing nothing at all | 11 of 12 |

The one false positive is named rather than rounded away. `legacy_ref` holds
internal references of the form `412-90-7731`, which is exactly the shape a
government identifier takes; nothing in the value distinguishes them, and this
tool does not guess. That is the class of error this design accepts, and
`test/acceptance.test.mjs` re-derives every number above from the shipped corpus.

Every value in that corpus is invented and drawn from ranges reserved for
documentation: `example.test` addresses, the Ofcom and NANP drama telephone
ranges, published card test numbers that belong to nobody, identifiers whose
leading group is one the issuing authority never assigns as a social-security
number, and the TEST-NET blocks of RFC 5737. No record in this repository
describes a real person.

## Non-goals

- **It connects to nothing.** No database, no warehouse, no host, no network call
  of any kind, in the tool or in its tests. The input is a document somebody
  exported.
- **It writes no file.** The report goes to stdout. There is no `--out`, no
  auto-fix and no destination to get wrong.
- **It does not read free text.** A recogniser matches a whole value, so an
  address quoted inside a note is not found. Prose scanning is where false
  positives come from, and this tool trades that recall away deliberately.
- **It does not read a bare `name` column as a person's name.** `name` names a
  product, a place, a file or a queue as often as a person, and `person-name`
  classifies no value, so a catalogue was reported `uncertain` at exit 2 on
  correct input. A column that holds people is named for them -- `full_name`,
  `customer_name`, `surname` -- or is acknowledged in the configuration.
- **It does not report a card number from an unlisted network.** `payment-card`
  requires an issuer identification number as well as the Luhn check, so a
  network missing from that table is missed. Luhn alone made a column of order
  numbers uncertain by chance, and a checker that does that is not read twice.
- **It does not overrule a column name with a shape that name also has.** A
  column whose name declares a version is not read as holding network addresses,
  so addresses in `firmware_version` are missed. The alternative was reporting
  every four-part build number as a network identifier at error severity, which
  is the one kind of error this design refuses to make.
- **It does not read a clock.** No wall-clock time, locale or filesystem order
  reaches the output; two runs over one document produce byte-identical stdout.
- **It is not a compliance assessment.** It reports the shape of values. Whether
  a value belongs to a real person, what lawful basis covers it and how long it
  may be kept are not in the document and are not in this report.
- **It does not decide for you.** A high-confidence match is evidence to check
  against the system of record, not a conclusion.

## Repository layout

- `src/` — the library: text boundary, rule catalog, recognisers, configuration,
  dataset reader, report assembly
- `bin/` — the command-line entry point
- `examples/` — three runnable corpora: passing, failing and incomplete
- `test/` — `node:test` suites covering the acceptance criteria item by item
- `docs/` — design notes

## Development

```sh
npm run check   # lint, tests, all three examples, and a packaging dry run
```

Zero runtime dependencies and zero development dependencies: Node's own test
runner and assertion library, and nothing else.

## License

MIT. See [LICENSE](./LICENSE).
