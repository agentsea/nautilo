---
name: computer-use
description: Operate the local desktop through the active signed Computer Use catalogue.
requiresTools: [computer_observe]
source: official
version: 12
---
# Computer Use

Use the active Computer Use tools shown for this turn. Their signed catalogue
metadata defines inputs, effects, recovery, and result meaning; do not invent
provider ids, window ids, coordinates, raw Cua commands, or unpublished tool
names. A native observation `query` is a short literal case-insensitive
substring matched against accessibility labels and values, not an instruction;
omit it for unfiltered window enumeration. Inventory completeness and bounded,
non-exhaustive content matching are separate: zero matches does not mean zero
windows, and fresh queried window targets are immediately usable. A
query-unavailable candidate was not searched; follow its reported recovery
instead of treating it as a zero match. After an uncertain mutation, obtain
fresh state before continuing.
