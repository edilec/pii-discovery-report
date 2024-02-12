# Changelog

All notable changes to this tool are recorded here. Rule ids are part of the
public surface: renaming one is a breaking change and is recorded as such.

## Unreleased

### Added

- `dataset-duplicate-key`, an error rule in the unsettled set. `JSON.parse`
  keeps one value of a repeated key and drops the rest before this tool sees the
  document, so a record of `{"contact": "a@example.test", "contact": "INT-0001"}`
  arrived as one field holding one value and was reported `clean` at exit 0 --
  an absence claim over a value the document holds. The keys the text spells are
  now counted and compared with the keys the parsed structure holds, and a
  document where they differ is `incomplete` with every field `undetermined`.

- `node-limit-exceeded`, an error rule in the unsettled set: the objects and
  arrays a document opens are counted in the text, before `JSON.parse` is
  called, and a document over 2000000 of them is refused unparsed. A file at the
  16777216-byte ceiling of `maxDatasetBytes` -- legal by every declared bound --
  can hold eight million empty arrays, and building them drove peak resident
  memory to 1.31 GB before the depth limit refused a single subtree. The same
  document now costs 88 MB, and the worst input the cap allows costs 364 MB.

### Removed

- `num`, a number formatter exported from `src/text.mjs`, tested, and called
  from nowhere in `src` or `bin`. An unreferenced helper that looks like part of
  the output boundary is worse than none: the next reader greps, finds it, and
  stops looking. It also carried a defect waiting for whoever wired it up --
  it guards its INPUT with `Number.isFinite` and then multiplies by 10000, so
  any finite value above about 1.8e302 came back as `Infinity`, which
  `JSON.stringify` writes as `null`. Every number in a report comes from `rate`
  or from `String(...)` on a count.

### Fixed

- The issuer table no longer declares a length the recogniser cannot reach. Four
  Maestro ranges listed 12 digits while `CARD_SHAPE` and `luhnValid` both refuse
  anything under 13, so the table promised what the code does not do. The rows
  now start at 13, and a test builds a number at every length in every range and
  drives it through the recogniser.

- The seeded corpus no longer carries a telephone number outside the reserved
  drama block its design notes name: `+44 20 7946 1101` is above Ofcom's London
  block of 020 7946 0000 to 0999 and could be assigned to a subscriber. Every
  `government_id` and `legacy_ref` now has `00` as its middle group, which
  neither the social-security nor the ITIN scheme issues, so no value in the
  corpus can be an identifier anybody holds; the shapes, and the one measured
  false positive that rests on them, are unchanged. `test/acceptance.test.mjs`
  now checks every range claim against the corpus.

- The exit-code table in the README and the exit-code section of `--help` both
  said exit 0 meant no field reached the configured confidence. That is false for
  every run whose fields are acknowledged: `personal-data-acknowledged` is `info`
  and outside the unsettled set, so a run exits 0 with fields classified
  `personal-data` at high confidence. The behaviour was always the intended one;
  both sentences now say so, and a CLI test drives the run they describe.

- A field path is now composed by ESCAPING each key, and read back with a parser
  rather than by splitting on `.`. A flat column named `contact.email` and a
  nested `contact` holding `email` composed to the same path, so they became one
  report entry with one merged match rate -- 4 of 8, for two fields that were 4
  of 4 and 0 of 4 -- and acknowledging one of them silenced the other at exit 0,
  status `pass`. A column literally named `tags[]` collided with the array `tags`
  the same way, and the pointer reproduced the collision even where the paths
  differed. `\`, `.`, `[` and `]` in a key are escaped with a backslash, which
  changes the path an `acknowledged` entry must name for such a key.

- `person-name` no longer matches a column named exactly `name`. The recogniser
  classifies no value, so a product catalogue with a `name` column became
  `uncertain` at low confidence and a correct run ended `incomplete` at exit 2.
  `surname`, `forename` and the `*_name` family are unchanged. The cost, named in
  the README: a `name` column that does hold people is reported `clean` unless
  the configuration acknowledges it.

- `payment-card` no longer draws a candidate from a Luhn collision. A Luhn check
  accepts one uniformly random digit string in ten at any length, so two of
  twelve internal sixteen-digit order numbers matched by chance and a clean run
  ended `incomplete` at exit 2. The recogniser now also requires an issuer
  identification number (ISO/IEC 7812-1) that a card network issues at that
  length, which takes a sixteen-digit reference from one in ten to 0.02833. The
  cost, named in the README: a card from a network the table does not list.

- `network-address` no longer reports a four-part build number as a network
  identifier. Every value in a column such as `app_version` is a legal dotted
  quad, so the column was classified `network-identifier` at high confidence and
  raised `personal-data-detected` at error severity, exit 1, on correct input. A
  column name that declares a version and says nothing about a network now
  refuses the recogniser. The cost, named in the README: a column of real
  addresses called `firmware_version` is missed.

## 0.1.0

First working version.

- Seven recognisers with a declared basis and a ceiling on their confidence:
  `email-address`, `payment-card`, `phone-number`, `government-id`,
  `network-address`, `date-of-birth` and `person-name`.
- Four classifications. `clean` is the only one that claims an absence, and it
  requires every value in the field to have been examined and the whole dataset
  to have been read.
- Eighteen rules with a frozen severity table, and an unsettled set that makes a
  run `incomplete` whenever a question it was asked stayed open.
- Masked examples only: no value from the dataset reaches the report.
- Declared byte, record, field, value-length and depth limits, each enforced
  before the work it bounds, plus a cap on the number of field observations one
  run may make.
- Three runnable corpora under `examples/`, ending at exit 0, 1 and 2.
