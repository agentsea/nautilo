/* tslint:disable */
/* eslint-disable */

/**
 * Messages produced by an Add commit: the proposal + commit (to fan out to
 * existing members) + the welcome (to onboard the new member).
 */
export class AddMessages {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    readonly commit: Uint8Array;
    readonly welcome: Uint8Array;
}

export class Group {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    static create_new(provider: Provider, founder: Identity, group_id: string): Group;
    /**
     * The MLS exporter secret — the lattice's single integration point.
     */
    export_key(provider: Provider, label: string, context: Uint8Array, key_length: number): Uint8Array;
    export_ratchet_tree(): RatchetTree;
    static join(provider: Provider, welcome: Uint8Array, ratchet_tree: RatchetTree): Group;
    /**
     * Rehydrate a group handle from the encrypted device-local provider
     * backup. This is deliberately not usable with public Delivery Service
     * state alone.
     */
    static load_device_state(provider: Provider, group_id: string): Group;
    /**
     * Authoritative public roster as a compact length-framed byte sequence:
     * count:u32, then repeated (leaf_index:u32, identity_len:u32, identity).
     * Basic credential identities are device IDs in the TypeScript provider.
     */
    member_roster(): Uint8Array;
    merge_pending_commit(provider: Provider): void;
    /**
     * The leaf index assigned by OpenMLS to this member. Adds reuse the
     * leftmost blank leaf, so callers must never synthesize this value.
     */
    own_leaf_index(): number;
    /**
     * Apply an incoming proposal or commit. Application messages return their
     * plaintext; proposals/commits are staged/merged and return an empty array.
     */
    process_message(provider: Provider, msg: Uint8Array): Uint8Array;
    propose_and_commit_add(provider: Provider, sender: Identity, new_member: KeyPackage): AddMessages;
    /**
     * === ADDED (not in upstream openmls-wasm) ===
     * Propose + commit removal of the member at `removed_index` (its MLS leaf
     * index). Mirrors `propose_and_commit_add`; produces no welcome.
     */
    propose_and_commit_remove(provider: Provider, sender: Identity, removed_index: number): RemoveMessages;
    /**
     * Create a real RFC 9420 self-update commit with a freshly generated leaf
     * encryption key. OpenMLS stages the commit; callers decide when to merge
     * it through `merge_pending_commit`.
     */
    propose_and_commit_update(provider: Provider, sender: Identity): UpdateMessages;
}

/**
 * A signing identity (BasicCredential + Ed25519 keypair).
 */
export class Identity {
    free(): void;
    [Symbol.dispose](): void;
    key_package(provider: Provider): KeyPackage;
    /**
     * Rehydrate the committing identity from a restored device keystore and
     * its own authenticated leaf. This makes restart restore fully
     * operational, rather than exporter-only.
     */
    static load(provider: Provider, group: Group): Identity;
    constructor(provider: Provider, name: string);
}

export class KeyPackage {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    static from_bytes(bytes: Uint8Array): KeyPackage;
    to_bytes(): Uint8Array;
}

/**
 * A per-client crypto + storage provider (in-memory keystore). One per
 * simulated device on the TS side.
 */
export class Provider {
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Restore device-local state previously returned by
     * `serialize_device_state`. Enforces exact, bounded parsing.
     */
    static deserialize_device_state(bytes: Uint8Array): Provider;
    constructor();
    /**
     * Device-local backup material. This contains the complete OpenMLS
     * keystore and MUST be encrypted by the TypeScript device vault before it
     * reaches durable storage. The public TypeScript provider never exposes
     * these raw bytes as server state.
     */
    serialize_device_state(): Uint8Array;
}

export class RatchetTree {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    static from_bytes(bytes: Uint8Array): RatchetTree;
    to_bytes(): Uint8Array;
}

/**
 * === ADDED (not in upstream openmls-wasm) ===
 * Messages produced by a Remove commit: proposal + commit. There is no welcome
 * on removal. Fanning out `commit` to the remaining members advances their MLS
 * epoch; the lattice epoch bump happens on the TS side.
 */
export class RemoveMessages {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    readonly commit: Uint8Array;
}

/**
 * === ADDED (not in upstream openmls-wasm) ===
 * Message produced by an RFC 9420 self-update commit. The caller must merge
 * the pending commit locally and fan out `commit` to the other members.
 */
export class UpdateMessages {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    readonly commit: Uint8Array;
}

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_addmessages_free: (a: number, b: number) => void;
    readonly __wbg_group_free: (a: number, b: number) => void;
    readonly __wbg_identity_free: (a: number, b: number) => void;
    readonly __wbg_keypackage_free: (a: number, b: number) => void;
    readonly __wbg_provider_free: (a: number, b: number) => void;
    readonly __wbg_ratchettree_free: (a: number, b: number) => void;
    readonly __wbg_removemessages_free: (a: number, b: number) => void;
    readonly addmessages_commit: (a: number) => any;
    readonly addmessages_welcome: (a: number) => any;
    readonly group_create_new: (a: number, b: number, c: number, d: number) => [number, number, number];
    readonly group_export_key: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => [number, number, number, number];
    readonly group_export_ratchet_tree: (a: number) => number;
    readonly group_join: (a: number, b: number, c: number, d: number) => [number, number, number];
    readonly group_load_device_state: (a: number, b: number, c: number) => [number, number, number];
    readonly group_member_roster: (a: number) => [number, number];
    readonly group_merge_pending_commit: (a: number, b: number) => [number, number];
    readonly group_own_leaf_index: (a: number) => number;
    readonly group_process_message: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly group_propose_and_commit_add: (a: number, b: number, c: number, d: number) => [number, number, number];
    readonly group_propose_and_commit_remove: (a: number, b: number, c: number, d: number) => [number, number, number];
    readonly group_propose_and_commit_update: (a: number, b: number, c: number) => [number, number, number];
    readonly identity_key_package: (a: number, b: number) => [number, number, number];
    readonly identity_load: (a: number, b: number) => [number, number, number];
    readonly identity_new: (a: number, b: number, c: number) => [number, number, number];
    readonly keypackage_from_bytes: (a: number, b: number) => [number, number, number];
    readonly keypackage_to_bytes: (a: number) => [number, number, number, number];
    readonly provider_deserialize_device_state: (a: number, b: number) => [number, number, number];
    readonly provider_new: () => number;
    readonly provider_serialize_device_state: (a: number) => [number, number, number, number];
    readonly ratchettree_from_bytes: (a: number, b: number) => [number, number, number];
    readonly ratchettree_to_bytes: (a: number) => [number, number, number, number];
    readonly removemessages_commit: (a: number) => any;
    readonly __wbg_updatemessages_free: (a: number, b: number) => void;
    readonly updatemessages_commit: (a: number) => any;
    readonly __wbindgen_exn_store: (a: number) => void;
    readonly __externref_table_alloc: () => number;
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
    readonly __externref_table_dealloc: (a: number) => void;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
