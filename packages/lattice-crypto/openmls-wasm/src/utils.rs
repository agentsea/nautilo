//! Small helpers for the wasm wrapper.

/// Placeholder for a panic hook. Kept as a no-op to avoid pulling
/// `console_error_panic_hook` into the default (size-sensitive) build; wire it
/// up here if you need readable Rust panics in the browser console during dev.
pub fn set_panic_hook() {}
