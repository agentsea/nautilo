/**
 * D403 (ISSUE-D403) Phase 2 — Argon2 backend for `kdbxweb`.
 *
 * `kdbxweb` ships no Argon2 implementation of its own; it must be given one via
 * `CryptoEngine.setArgon2Impl` before any KDBX4 load/save (KDBX4 uses Argon2 as
 * its KDF). We back it with `@noble/hashes` argon2id/argon2d — both pure-JS, so
 * no native binary vendoring (matches the spec §R3 / risk note).
 *
 * Electron-FREE by design (only `kdbxweb` + `@noble/hashes`) so the store and
 * its unit tests can install the impl without an Electron runtime.
 *
 * Unit mapping — `kdbxweb` calls the impl as
 *   (password, salt, memory, iterations, length, parallelism, type, version)
 * where `memory` is already in **KiB** (kdbxweb divides the KDF `M` byte count
 * by 1024 before calling us), which lines up 1:1 with `@noble/hashes`' `m`
 * (also KiB). `length` → `dkLen`, `iterations` → `t`, `parallelism` → `p`.
 */

import * as kdbxweb from "kdbxweb";
import { argon2d, argon2id } from "@noble/hashes/argon2.js";

let installed = false;

/**
 * Install the `@noble/hashes`-backed Argon2 implementation into `kdbxweb`.
 * Idempotent — safe to call from every backend/store construction and from
 * test setup; only the first call registers the impl.
 */
export function setKdbxArgon2Impl(): void {
  if (installed) return;
  installed = true;

  kdbxweb.CryptoEngine.setArgon2Impl(
    (
      password: ArrayBuffer,
      salt: ArrayBuffer,
      memory: number,
      iterations: number,
      length: number,
      parallelism: number,
      type: kdbxweb.CryptoEngine.Argon2Type,
      version: kdbxweb.CryptoEngine.Argon2Version,
    ): Promise<ArrayBuffer> => {
      const pwd = new Uint8Array(password);
      const slt = new Uint8Array(salt);
      const opts = {
        t: iterations,
        m: memory,
        p: parallelism,
        dkLen: length,
        version,
      };
      const derive =
        type === kdbxweb.CryptoEngine.Argon2TypeArgon2d ? argon2d : argon2id;
      const hash: Uint8Array = derive(pwd, slt, opts);
      // Return a freshly-owned ArrayBuffer of exactly `length` bytes (never a
      // view into a larger pooled buffer).
      const out = new Uint8Array(hash.byteLength);
      out.set(hash);
      return Promise.resolve(out.buffer);
    },
  );
}
