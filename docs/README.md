# pii-discovery-report design notes

The README is the contract. These are the decisions behind it, kept where the
next person to change the tool will look for them.

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
Whole-value matching, a checksum on `payment-card`, and a `phone-number` that
refuses a bare run of digits are all deliberate losses of recall, bought to keep
the output worth reading. The measured consequence is in the README, including
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

## Fixtures

Every value in `examples/` is invented. The addresses use the reserved
`example.test` domain, the telephone numbers come from the Ofcom and NANP drama
ranges, the card numbers are the published test values that pass Luhn and belong
to nobody, the `government_id` values use a leading group the issuing authority
never assigns as a social-security number, and the addresses in `last_seen_ip`
are the TEST-NET blocks RFC 5737 reserves for documentation. No record here
describes a real person, and none was copied from anywhere.
