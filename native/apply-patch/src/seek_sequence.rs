//! Modified extraction of Codex `seek_sequence.rs` (Apache-2.0).
//!
//! The matching order is retained: exact, trailing whitespace, full whitespace,
//! then the pinned Unicode punctuation normalization pass. Nautilo removed
//! unrelated upstream tests and keeps this helper filesystem-neutral.

pub(crate) fn seek_sequence(
    lines: &[String],
    pattern: &[String],
    start: usize,
    eof: bool,
) -> Option<usize> {
    if pattern.is_empty() {
        return Some(start);
    }
    if pattern.len() > lines.len() {
        return None;
    }
    let search_start = if eof && lines.len() >= pattern.len() {
        lines.len() - pattern.len()
    } else {
        start
    };
    let end = lines.len().saturating_sub(pattern.len());
    for i in search_start..=end {
        if lines[i..i + pattern.len()] == *pattern {
            return Some(i);
        }
    }
    for i in search_start..=end {
        if lines[i..i + pattern.len()]
            .iter()
            .zip(pattern)
            .all(|(line, wanted)| line.trim_end() == wanted.trim_end())
        {
            return Some(i);
        }
    }
    for i in search_start..=end {
        if lines[i..i + pattern.len()]
            .iter()
            .zip(pattern)
            .all(|(line, wanted)| line.trim() == wanted.trim())
        {
            return Some(i);
        }
    }
    for i in search_start..=end {
        if lines[i..i + pattern.len()]
            .iter()
            .zip(pattern)
            .all(|(line, wanted)| normalize(line) == normalize(wanted))
        {
            return Some(i);
        }
    }
    None
}

fn normalize(value: &str) -> String {
    value
        .trim()
        .chars()
        .map(|character| match character {
            '\u{2010}' | '\u{2011}' | '\u{2012}' | '\u{2013}' | '\u{2014}' | '\u{2015}'
            | '\u{2212}' => '-',
            '\u{2018}' | '\u{2019}' | '\u{201A}' | '\u{201B}' => '\'',
            '\u{201C}' | '\u{201D}' | '\u{201E}' | '\u{201F}' => '"',
            '\u{00A0}' | '\u{2002}' | '\u{2003}' | '\u{2004}' | '\u{2005}' | '\u{2006}'
            | '\u{2007}' | '\u{2008}' | '\u{2009}' | '\u{200A}' | '\u{202F}' | '\u{205F}'
            | '\u{3000}' => ' ',
            other => other,
        })
        .collect()
}
