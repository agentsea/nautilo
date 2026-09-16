# Nautilo security research rules

These MIT-licensed rules are a deliberately small, locally distributed lead
generator for Genie's model-led security research. They focus on untrusted
variable flow into command, code-evaluation, filesystem, SQL, and outbound
network sinks in JavaScript/TypeScript, Python, and Go.

Matches are scanner observations, not vulnerability conclusions. Genie must
inspect definitions, validation, authorization, callers, configuration, tests,
and counterevidence before recording a finding or dismissal. The release
pipeline packages this directory as a separately versioned and digested rules
artifact; the Semgrep engine never fetches registry or `--config auto` rules.
