# pii-discovery-report design notes

The README is the contract. These are the decisions behind it, kept where the
next person to change the tool will look for them.
[`mutation-sweep.md`](./mutation-sweep.md) beside this file is the enumeration
the guarantees here were driven against, and what survived it.

## Why `clean` is the only hard word

Three of the four classifications are admissions and one is a claim. `clean`
says every value in the field was examined, the whole dataset was read, and no
recogniser matched. Everything that could weaken that -- a record that is not an
object, a subtree past the depth limit, a value over the length limit, a whole
number wider than a JSON reader keeps, a key that would not print as it is
stored, a truncated record list -- is counted rather than skipped, and any one of
them turns the field `undetermined`.

The counters are the reason the report can be read at all. `examined`, `matched`,
`unexamined`, `tooLong`, `notExact` and `notApplicable` are all on every field
entry, so a reader can see what the verdict rests on instead of trusting it.

## Why the keys are counted twice

`JSON.parse` resolves a repeated key before this tool sees anything. A record of
`{"contact": "ada@example.test", "contact": "INT-0001"}` arrives as one field
holding one value, and the field was reported `clean` at exit 0 -- an absence
claim over a value the document holds and this run never examined. The one
failure this tool exists to avoid, arriving before it starts.

Detecting it needs no parser. The document has already parsed by the time the
question is asked, and in well-formed JSON a `:` follows a string only when that
string is an object key, so the keys the text spells are the strings a colon
follows. They are compared with the keys the parsed structure holds -- counted
iteratively, because the node bound allows a document two million levels deep
and a recursive count would exhaust the stack rather than answer. A difference
is `dataset-duplicate-key`, `incomplete`, exit 2, and no field in that document
is clean.

The counter that would hurt is the one that miscounts a correct export, so both
counters are driven over every shipped corpus and over the shapes a scanner gets
wrong: a colon inside a string, an escaped quote, a key holding a backslash,
whitespace and newlines between a key and its colon.

## Why an acknowledged field is not a silencer

`acknowledged` says the operator has declared a field to hold personal data. It
settles the question in the direction of presence and never in the direction of
absence, so it downgrades the finding about that field to `info` and leaves every
finding about an unexamined value exactly where it was. An unexamined value may
hold a category nobody declared.

The list is also an index, and an index built from discarded evidence makes every
comparison against it incomplete. So an entry that cannot be compared -- one that
prints as nothing, one over the path length, one that would not print as it is
written -- is refused when the configuration is read, rather than dropped
quietly. A dropped entry would silently un-acknowledge a field.

## Why the recognisers are narrow

A checker that reports a defect on correct input is worse than one that misses.
Whole-value matching, an issuer range and a checksum on `payment-card`, and a
`phone-number` that refuses a bare run of digits are all deliberate losses of
recall, bought to keep the output worth reading.

The checksum by itself was not enough, and the arithmetic says why: Luhn accepts
one uniformly random digit string in ten at any length, so twelve internal order
numbers produce a match about as often as not. Two of twelve did, and a clean run
ended `incomplete` at exit 2. A primary account number is not any Luhn-passing
run of digits -- ISO/IEC 7812-1 assigns its leading digits to an issuer, and each
network issues fixed lengths -- so the issuer range is checked as well, which
takes a sixteen-digit reference from one in ten to 0.02833. The measured consequence is in the README, including
the one false positive the shipped corpus produces.

A column name is also evidence AGAINST a reading, and missing that produced the
sharpest defect this tool has had: `1.2.3.4` is a legal IPv4 address and a legal
four-part build number, so a column of build numbers was reported as a network
identifier at high confidence, at error severity, exit 1 -- a finding on correct
input. Nothing in the value distinguishes the two readings; the column name does,
and the tool was already using a column name in the other direction. So
`network-address` carries `refusedByName`, and a name that declares a version
while saying nothing about a network refuses it. `network-address` is the only
recogniser with a refusal, because a dotted quad is the only shape here that
another ordinary kind of column takes in full.

Two recognisers rest partly or wholly on the name of a column, and the report
says so in every candidate through `basis`. `person-name` classifies no value at
all and carries `valuesClassified: false`, because nothing about the characters
in a personal name distinguishes it from a place, a product or a pseudonym.

## Why a field name must print exactly as it is stored

A key that merely survives sanitising is not safe to use as an identity:
`a<U+0001>b` and `a b` print the same and are two different fields in the
document. Accepting the first would silently merge them in the report, so the
rule is equality between the stored form and the printed form, and a key that
fails it is counted as unexamined.

That rule removes the SANITISING collision, and for a while this section claimed
it removed the collision, full stop. It did not, and the sentence was worse than
silence because the next reader checked the code against it and stopped looking.
A path is also COMPOSED, by joining keys with `.` and marking an array level with
`[]`, and a key may contain both: a flat column named `contact.email` and a
nested `contact` holding `email` composed to the same path, merged into one
report entry with one match rate of 0.5 over two fields that were 1.0 and 0.0,
and one `acknowledged` entry silenced the other at exit 0. A column literally
named `tags[]` collided with the array `tags` the same way, and the pointer --
built by splitting the composed path back on `.` -- reproduced the collision even
where the paths differed.

So a key is escaped into its segment (`escapePathSegment`) and a path is read
back with a parser (`splitFieldPath`), which is the only thing in this tool
allowed to take a path apart. Both are exercised by `test/paths.test.mjs` through
the report and through the CLI exit code, because the failure this prevents is an
exit code and not a string.

## Why the parse has its own bound

The limits looked complete and were not. `maxDatasetBytes` bounds the text,
`maxRecords`, `maxFields` and `maxDepth` bound the traversal, and
`maxRecords * maxFields` bounds the observations -- and every one of them is
checked either before the file is read or during the walk. The parse sits
between those two, and nothing bounded it.

`[` is one byte of text and about 160 bytes of memory. A file of 16777216 bytes,
which is the ceiling `maxDatasetBytes` may legally be raised to, holds eight
million of them, and `JSON.parse` builds every one before `observeRecords` sees
a single subtree to refuse. Measured: 1.31 GB peak resident memory on a document
this tool calls legal, ending at exit 2 with `record-too-deep` -- the right
verdict, reached the expensive way.

So `countNodes` scans the text first and refuses a document that opens more than
2000000 objects and arrays. It allocates nothing, it stops as soon as the limit
is passed, and it tracks string state because a `[` inside a string is prose.
The bound is on the WORK, not on the output.

## Fixtures

Every value in `examples/` is invented, and every claim in this section is
checked against the corpus by `test/acceptance.test.mjs` rather than asserted
here. That test exists because one telephone number was not what this paragraph
said it was: `+44 20 7946 1101` sat outside the Ofcom London drama block, which
is 020 7946 **0**000 to 0999, in a range that can be assigned to a subscriber.

- Addresses use the reserved `example.test` domain.
- Telephone numbers come from the NANP 555-0100 to 555-0199 block and Ofcom's
  020 7946 0000 to 0999 block.
- Card numbers are the values the networks publish for testing, which pass Luhn
  and belong to nobody.
- Every `government_id` and every `legacy_ref` has `00` as its middle group.
  That group is issued by neither scheme the shape belongs to -- a
  social-security number has no `00` group, and an ITIN's middle pair is 50-65,
  70-88, 90-92 or 94-99 -- so no value here can be an identifier anybody holds.
  The shape is unchanged, which is the point: `legacy_ref` is an internal
  reference that collides with `government-id` on shape alone, and that
  collision is the one false positive the README measures.
- `last_seen_ip` uses the TEST-NET blocks RFC 5737 reserves for documentation.

No record here describes a real person, and none was copied from anywhere.
