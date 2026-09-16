/* @ts-self-types="./openmls_wasm.d.ts" */

/**
 * Messages produced by an Add commit: the proposal + commit (to fan out to
 * existing members) + the welcome (to onboard the new member).
 */
export class AddMessages {
    static __wrap(ptr) {
        const obj = Object.create(AddMessages.prototype);
        obj.__wbg_ptr = ptr;
        AddMessagesFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        AddMessagesFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_addmessages_free(ptr, 0);
    }
    /**
     * @returns {Uint8Array}
     */
    get commit() {
        const ret = wasm.addmessages_commit(this.__wbg_ptr);
        return ret;
    }
    /**
     * @returns {Uint8Array}
     */
    get welcome() {
        const ret = wasm.addmessages_welcome(this.__wbg_ptr);
        return ret;
    }
}
if (Symbol.dispose) AddMessages.prototype[Symbol.dispose] = AddMessages.prototype.free;

export class Group {
    static __wrap(ptr) {
        const obj = Object.create(Group.prototype);
        obj.__wbg_ptr = ptr;
        GroupFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        GroupFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_group_free(ptr, 0);
    }
    /**
     * @param {Provider} provider
     * @param {Identity} founder
     * @param {string} group_id
     * @returns {Group}
     */
    static create_new(provider, founder, group_id) {
        _assertClass(provider, Provider);
        _assertClass(founder, Identity);
        const ptr0 = passStringToWasm0(group_id, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.group_create_new(provider.__wbg_ptr, founder.__wbg_ptr, ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return Group.__wrap(ret[0]);
    }
    /**
     * The MLS exporter secret — the lattice's single integration point.
     * @param {Provider} provider
     * @param {string} label
     * @param {Uint8Array} context
     * @param {number} key_length
     * @returns {Uint8Array}
     */
    export_key(provider, label, context, key_length) {
        _assertClass(provider, Provider);
        const ptr0 = passStringToWasm0(label, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passArray8ToWasm0(context, wasm.__wbindgen_malloc);
        const len1 = WASM_VECTOR_LEN;
        const ret = wasm.group_export_key(this.__wbg_ptr, provider.__wbg_ptr, ptr0, len0, ptr1, len1, key_length);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v3 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v3;
    }
    /**
     * @returns {RatchetTree}
     */
    export_ratchet_tree() {
        const ret = wasm.group_export_ratchet_tree(this.__wbg_ptr);
        return RatchetTree.__wrap(ret);
    }
    /**
     * @param {Provider} provider
     * @param {Uint8Array} welcome
     * @param {RatchetTree} ratchet_tree
     * @returns {Group}
     */
    static join(provider, welcome, ratchet_tree) {
        _assertClass(provider, Provider);
        const ptr0 = passArray8ToWasm0(welcome, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        _assertClass(ratchet_tree, RatchetTree);
        const ret = wasm.group_join(provider.__wbg_ptr, ptr0, len0, ratchet_tree.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return Group.__wrap(ret[0]);
    }
    /**
     * Rehydrate a group handle from the encrypted device-local provider
     * backup. This is deliberately not usable with public Delivery Service
     * state alone.
     * @param {Provider} provider
     * @param {string} group_id
     * @returns {Group}
     */
    static load_device_state(provider, group_id) {
        _assertClass(provider, Provider);
        const ptr0 = passStringToWasm0(group_id, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.group_load_device_state(provider.__wbg_ptr, ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return Group.__wrap(ret[0]);
    }
    /**
     * Authoritative public roster as a compact length-framed byte sequence:
     * count:u32, then repeated (leaf_index:u32, identity_len:u32, identity).
     * Basic credential identities are device IDs in the TypeScript provider.
     * @returns {Uint8Array}
     */
    member_roster() {
        const ret = wasm.group_member_roster(this.__wbg_ptr);
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
    /**
     * @param {Provider} provider
     */
    merge_pending_commit(provider) {
        _assertClass(provider, Provider);
        const ret = wasm.group_merge_pending_commit(this.__wbg_ptr, provider.__wbg_ptr);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * The leaf index assigned by OpenMLS to this member. Adds reuse the
     * leftmost blank leaf, so callers must never synthesize this value.
     * @returns {number}
     */
    own_leaf_index() {
        const ret = wasm.group_own_leaf_index(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Apply an incoming proposal or commit. Application messages return their
     * plaintext; proposals/commits are staged/merged and return an empty array.
     * @param {Provider} provider
     * @param {Uint8Array} msg
     * @returns {Uint8Array}
     */
    process_message(provider, msg) {
        _assertClass(provider, Provider);
        const ptr0 = passArray8ToWasm0(msg, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.group_process_message(this.__wbg_ptr, provider.__wbg_ptr, ptr0, len0);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v2 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v2;
    }
    /**
     * @param {Provider} provider
     * @param {Identity} sender
     * @param {KeyPackage} new_member
     * @returns {AddMessages}
     */
    propose_and_commit_add(provider, sender, new_member) {
        _assertClass(provider, Provider);
        _assertClass(sender, Identity);
        _assertClass(new_member, KeyPackage);
        const ret = wasm.group_propose_and_commit_add(this.__wbg_ptr, provider.__wbg_ptr, sender.__wbg_ptr, new_member.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return AddMessages.__wrap(ret[0]);
    }
    /**
     * === ADDED (not in upstream openmls-wasm) ===
     * Propose + commit removal of the member at `removed_index` (its MLS leaf
     * index). Mirrors `propose_and_commit_add`; produces no welcome.
     * @param {Provider} provider
     * @param {Identity} sender
     * @param {number} removed_index
     * @returns {RemoveMessages}
     */
    propose_and_commit_remove(provider, sender, removed_index) {
        _assertClass(provider, Provider);
        _assertClass(sender, Identity);
        const ret = wasm.group_propose_and_commit_remove(this.__wbg_ptr, provider.__wbg_ptr, sender.__wbg_ptr, removed_index);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return RemoveMessages.__wrap(ret[0]);
    }
    /**
     * Create a real RFC 9420 self-update commit with a freshly generated leaf
     * encryption key. OpenMLS stages the commit; callers decide when to merge
     * it through `merge_pending_commit`.
     * @param {Provider} provider
     * @param {Identity} sender
     * @returns {UpdateMessages}
     */
    propose_and_commit_update(provider, sender) {
        _assertClass(provider, Provider);
        _assertClass(sender, Identity);
        const ret = wasm.group_propose_and_commit_update(this.__wbg_ptr, provider.__wbg_ptr, sender.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return UpdateMessages.__wrap(ret[0]);
    }
}
if (Symbol.dispose) Group.prototype[Symbol.dispose] = Group.prototype.free;

/**
 * A signing identity (BasicCredential + Ed25519 keypair).
 */
export class Identity {
    static __wrap(ptr) {
        const obj = Object.create(Identity.prototype);
        obj.__wbg_ptr = ptr;
        IdentityFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        IdentityFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_identity_free(ptr, 0);
    }
    /**
     * @param {Provider} provider
     * @returns {KeyPackage}
     */
    key_package(provider) {
        _assertClass(provider, Provider);
        const ret = wasm.identity_key_package(this.__wbg_ptr, provider.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return KeyPackage.__wrap(ret[0]);
    }
    /**
     * Rehydrate the committing identity from a restored device keystore and
     * its own authenticated leaf. This makes restart restore fully
     * operational, rather than exporter-only.
     * @param {Provider} provider
     * @param {Group} group
     * @returns {Identity}
     */
    static load(provider, group) {
        _assertClass(provider, Provider);
        _assertClass(group, Group);
        const ret = wasm.identity_load(provider.__wbg_ptr, group.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return Identity.__wrap(ret[0]);
    }
    /**
     * @param {Provider} provider
     * @param {string} name
     */
    constructor(provider, name) {
        _assertClass(provider, Provider);
        const ptr0 = passStringToWasm0(name, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.identity_new(provider.__wbg_ptr, ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        this.__wbg_ptr = ret[0];
        IdentityFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
}
if (Symbol.dispose) Identity.prototype[Symbol.dispose] = Identity.prototype.free;

export class KeyPackage {
    static __wrap(ptr) {
        const obj = Object.create(KeyPackage.prototype);
        obj.__wbg_ptr = ptr;
        KeyPackageFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        KeyPackageFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_keypackage_free(ptr, 0);
    }
    /**
     * @param {Uint8Array} bytes
     * @returns {KeyPackage}
     */
    static from_bytes(bytes) {
        const ptr0 = passArray8ToWasm0(bytes, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.keypackage_from_bytes(ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return KeyPackage.__wrap(ret[0]);
    }
    /**
     * @returns {Uint8Array}
     */
    to_bytes() {
        const ret = wasm.keypackage_to_bytes(this.__wbg_ptr);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
}
if (Symbol.dispose) KeyPackage.prototype[Symbol.dispose] = KeyPackage.prototype.free;

/**
 * A per-client crypto + storage provider (in-memory keystore). One per
 * simulated device on the TS side.
 */
export class Provider {
    static __wrap(ptr) {
        const obj = Object.create(Provider.prototype);
        obj.__wbg_ptr = ptr;
        ProviderFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        ProviderFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_provider_free(ptr, 0);
    }
    /**
     * Restore device-local state previously returned by
     * `serialize_device_state`. Enforces exact, bounded parsing.
     * @param {Uint8Array} bytes
     * @returns {Provider}
     */
    static deserialize_device_state(bytes) {
        const ptr0 = passArray8ToWasm0(bytes, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.provider_deserialize_device_state(ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return Provider.__wrap(ret[0]);
    }
    constructor() {
        const ret = wasm.provider_new();
        this.__wbg_ptr = ret;
        ProviderFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
    /**
     * Device-local backup material. This contains the complete OpenMLS
     * keystore and MUST be encrypted by the TypeScript device vault before it
     * reaches durable storage. The public TypeScript provider never exposes
     * these raw bytes as server state.
     * @returns {Uint8Array}
     */
    serialize_device_state() {
        const ret = wasm.provider_serialize_device_state(this.__wbg_ptr);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
}
if (Symbol.dispose) Provider.prototype[Symbol.dispose] = Provider.prototype.free;

export class RatchetTree {
    static __wrap(ptr) {
        const obj = Object.create(RatchetTree.prototype);
        obj.__wbg_ptr = ptr;
        RatchetTreeFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        RatchetTreeFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_ratchettree_free(ptr, 0);
    }
    /**
     * @param {Uint8Array} bytes
     * @returns {RatchetTree}
     */
    static from_bytes(bytes) {
        const ptr0 = passArray8ToWasm0(bytes, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.ratchettree_from_bytes(ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return RatchetTree.__wrap(ret[0]);
    }
    /**
     * @returns {Uint8Array}
     */
    to_bytes() {
        const ret = wasm.ratchettree_to_bytes(this.__wbg_ptr);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
}
if (Symbol.dispose) RatchetTree.prototype[Symbol.dispose] = RatchetTree.prototype.free;

/**
 * === ADDED (not in upstream openmls-wasm) ===
 * Messages produced by a Remove commit: proposal + commit. There is no welcome
 * on removal. Fanning out `commit` to the remaining members advances their MLS
 * epoch; the lattice epoch bump happens on the TS side.
 */
export class RemoveMessages {
    static __wrap(ptr) {
        const obj = Object.create(RemoveMessages.prototype);
        obj.__wbg_ptr = ptr;
        RemoveMessagesFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        RemoveMessagesFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_removemessages_free(ptr, 0);
    }
    /**
     * @returns {Uint8Array}
     */
    get commit() {
        const ret = wasm.removemessages_commit(this.__wbg_ptr);
        return ret;
    }
}
if (Symbol.dispose) RemoveMessages.prototype[Symbol.dispose] = RemoveMessages.prototype.free;

/**
 * === ADDED (not in upstream openmls-wasm) ===
 * Message produced by an RFC 9420 self-update commit. The caller must merge
 * the pending commit locally and fan out `commit` to the other members.
 */
export class UpdateMessages {
    static __wrap(ptr) {
        const obj = Object.create(UpdateMessages.prototype);
        obj.__wbg_ptr = ptr;
        UpdateMessagesFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        UpdateMessagesFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_updatemessages_free(ptr, 0);
    }
    /**
     * @returns {Uint8Array}
     */
    get commit() {
        const ret = wasm.updatemessages_commit(this.__wbg_ptr);
        return ret;
    }
}
if (Symbol.dispose) UpdateMessages.prototype[Symbol.dispose] = UpdateMessages.prototype.free;
function __wbg_get_imports() {
    const import0 = {
        __proto__: null,
        __wbg_Error_92b29b0548f8b746: function(arg0, arg1) {
            const ret = Error(getStringFromWasm0(arg0, arg1));
            return ret;
        },
        __wbg___wbindgen_is_function_1ff95bcc5517c252: function(arg0) {
            const ret = typeof(arg0) === 'function';
            return ret;
        },
        __wbg___wbindgen_is_object_a27215656b807791: function(arg0) {
            const val = arg0;
            const ret = typeof(val) === 'object' && val !== null;
            return ret;
        },
        __wbg___wbindgen_is_string_ea5e6cc2e4141dfe: function(arg0) {
            const ret = typeof(arg0) === 'string';
            return ret;
        },
        __wbg___wbindgen_is_undefined_c05833b95a3cf397: function(arg0) {
            const ret = arg0 === undefined;
            return ret;
        },
        __wbg___wbindgen_throw_344f42d3211c4765: function(arg0, arg1) {
            throw new Error(getStringFromWasm0(arg0, arg1));
        },
        __wbg_call_a6e5c5dce5018821: function() { return handleError(function (arg0, arg1, arg2) {
            const ret = arg0.call(arg1, arg2);
            return ret;
        }, arguments); },
        __wbg_crypto_38df2bab126b63dc: function(arg0) {
            const ret = arg0.crypto;
            return ret;
        },
        __wbg_getRandomValues_c44a50d8cfdaebeb: function() { return handleError(function (arg0, arg1) {
            arg0.getRandomValues(arg1);
        }, arguments); },
        __wbg_length_1f0964f4a5e2c6d8: function(arg0) {
            const ret = arg0.length;
            return ret;
        },
        __wbg_msCrypto_bd5a034af96bcba6: function(arg0) {
            const ret = arg0.msCrypto;
            return ret;
        },
        __wbg_new_cd45aabdf6073e84: function(arg0) {
            const ret = new Uint8Array(arg0);
            return ret;
        },
        __wbg_new_with_length_e6785c33c8e4cce8: function(arg0) {
            const ret = new Uint8Array(arg0 >>> 0);
            return ret;
        },
        __wbg_node_84ea875411254db1: function(arg0) {
            const ret = arg0.node;
            return ret;
        },
        __wbg_now_86c0d4ba3fa605b8: function() {
            const ret = Date.now();
            return ret;
        },
        __wbg_process_44c7a14e11e9f69e: function(arg0) {
            const ret = arg0.process;
            return ret;
        },
        __wbg_prototypesetcall_4770620bbe4688a0: function(arg0, arg1, arg2) {
            Uint8Array.prototype.set.call(getArrayU8FromWasm0(arg0, arg1), arg2);
        },
        __wbg_randomFillSync_6c25eac9869eb53c: function() { return handleError(function (arg0, arg1) {
            arg0.randomFillSync(arg1);
        }, arguments); },
        __wbg_require_b4edbdcf3e2a1ef0: function() { return handleError(function () {
            const ret = module.require;
            return ret;
        }, arguments); },
        __wbg_static_accessor_GLOBAL_4ef717fb391d88b7: function() {
            const ret = typeof global === 'undefined' ? null : global;
            return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
        },
        __wbg_static_accessor_GLOBAL_THIS_8d1badc68b5a74f4: function() {
            const ret = typeof globalThis === 'undefined' ? null : globalThis;
            return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
        },
        __wbg_static_accessor_SELF_146583524fe1469b: function() {
            const ret = typeof self === 'undefined' ? null : self;
            return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
        },
        __wbg_static_accessor_WINDOW_f2829a2234d7819e: function() {
            const ret = typeof window === 'undefined' ? null : window;
            return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
        },
        __wbg_subarray_3ed232c8a6baee09: function(arg0, arg1, arg2) {
            const ret = arg0.subarray(arg1 >>> 0, arg2 >>> 0);
            return ret;
        },
        __wbg_versions_276b2795b1c6a219: function(arg0) {
            const ret = arg0.versions;
            return ret;
        },
        __wbindgen_cast_0000000000000001: function(arg0, arg1) {
            // Cast intrinsic for `Ref(Slice(U8)) -> NamedExternref("Uint8Array")`.
            const ret = getArrayU8FromWasm0(arg0, arg1);
            return ret;
        },
        __wbindgen_cast_0000000000000002: function(arg0, arg1) {
            // Cast intrinsic for `Ref(String) -> Externref`.
            const ret = getStringFromWasm0(arg0, arg1);
            return ret;
        },
        __wbindgen_init_externref_table: function() {
            const table = wasm.__wbindgen_externrefs;
            const offset = table.grow(4);
            table.set(0, undefined);
            table.set(offset + 0, undefined);
            table.set(offset + 1, null);
            table.set(offset + 2, true);
            table.set(offset + 3, false);
        },
    };
    return {
        __proto__: null,
        "./openmls_wasm_bg.js": import0,
    };
}

const AddMessagesFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_addmessages_free(ptr, 1));
const GroupFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_group_free(ptr, 1));
const IdentityFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_identity_free(ptr, 1));
const KeyPackageFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_keypackage_free(ptr, 1));
const ProviderFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_provider_free(ptr, 1));
const RatchetTreeFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_ratchettree_free(ptr, 1));
const RemoveMessagesFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_removemessages_free(ptr, 1));
const UpdateMessagesFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_updatemessages_free(ptr, 1));

function addToExternrefTable0(obj) {
    const idx = wasm.__externref_table_alloc();
    wasm.__wbindgen_externrefs.set(idx, obj);
    return idx;
}

function _assertClass(instance, klass) {
    if (!(instance instanceof klass)) {
        throw new Error(`expected instance of ${klass.name}`);
    }
}

function getArrayU8FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getUint8ArrayMemory0().subarray(ptr / 1, ptr / 1 + len);
}

function getStringFromWasm0(ptr, len) {
    return decodeText(ptr >>> 0, len);
}

let cachedUint8ArrayMemory0 = null;
function getUint8ArrayMemory0() {
    if (cachedUint8ArrayMemory0 === null || cachedUint8ArrayMemory0.byteLength === 0) {
        cachedUint8ArrayMemory0 = new Uint8Array(wasm.memory.buffer);
    }
    return cachedUint8ArrayMemory0;
}

function handleError(f, args) {
    try {
        return f.apply(this, args);
    } catch (e) {
        const idx = addToExternrefTable0(e);
        wasm.__wbindgen_exn_store(idx);
    }
}

function isLikeNone(x) {
    return x === undefined || x === null;
}

function passArray8ToWasm0(arg, malloc) {
    const ptr = malloc(arg.length * 1, 1) >>> 0;
    getUint8ArrayMemory0().set(arg, ptr / 1);
    WASM_VECTOR_LEN = arg.length;
    return ptr;
}

function passStringToWasm0(arg, malloc, realloc) {
    if (realloc === undefined) {
        const buf = cachedTextEncoder.encode(arg);
        const ptr = malloc(buf.length, 1) >>> 0;
        getUint8ArrayMemory0().subarray(ptr, ptr + buf.length).set(buf);
        WASM_VECTOR_LEN = buf.length;
        return ptr;
    }

    let len = arg.length;
    let ptr = malloc(len, 1) >>> 0;

    const mem = getUint8ArrayMemory0();

    let offset = 0;

    for (; offset < len; offset++) {
        const code = arg.charCodeAt(offset);
        if (code > 0x7F) break;
        mem[ptr + offset] = code;
    }
    if (offset !== len) {
        if (offset !== 0) {
            arg = arg.slice(offset);
        }
        ptr = realloc(ptr, len, len = offset + arg.length * 3, 1) >>> 0;
        const view = getUint8ArrayMemory0().subarray(ptr + offset, ptr + len);
        const ret = cachedTextEncoder.encodeInto(arg, view);

        offset += ret.written;
        ptr = realloc(ptr, len, offset, 1) >>> 0;
    }

    WASM_VECTOR_LEN = offset;
    return ptr;
}

function takeFromExternrefTable0(idx) {
    const value = wasm.__wbindgen_externrefs.get(idx);
    wasm.__externref_table_dealloc(idx);
    return value;
}

let cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
cachedTextDecoder.decode();
const MAX_SAFARI_DECODE_BYTES = 2146435072;
let numBytesDecoded = 0;
function decodeText(ptr, len) {
    numBytesDecoded += len;
    if (numBytesDecoded >= MAX_SAFARI_DECODE_BYTES) {
        cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
        cachedTextDecoder.decode();
        numBytesDecoded = len;
    }
    return cachedTextDecoder.decode(getUint8ArrayMemory0().subarray(ptr, ptr + len));
}

const cachedTextEncoder = new TextEncoder();

if (!('encodeInto' in cachedTextEncoder)) {
    cachedTextEncoder.encodeInto = function (arg, view) {
        const buf = cachedTextEncoder.encode(arg);
        view.set(buf);
        return {
            read: arg.length,
            written: buf.length
        };
    };
}

let WASM_VECTOR_LEN = 0;

let wasmModule, wasmInstance, wasm;
function __wbg_finalize_init(instance, module) {
    wasmInstance = instance;
    wasm = instance.exports;
    wasmModule = module;
    cachedUint8ArrayMemory0 = null;
    wasm.__wbindgen_start();
    return wasm;
}

async function __wbg_load(module, imports) {
    if (typeof Response === 'function' && module instanceof Response) {
        if (typeof WebAssembly.instantiateStreaming === 'function') {
            try {
                return await WebAssembly.instantiateStreaming(module, imports);
            } catch (e) {
                const validResponse = module.ok && expectedResponseType(module.type);

                if (validResponse && module.headers.get('Content-Type') !== 'application/wasm') {
                    console.warn("`WebAssembly.instantiateStreaming` failed because your server does not serve Wasm with `application/wasm` MIME type. Falling back to `WebAssembly.instantiate` which is slower. Original error:\n", e);

                } else { throw e; }
            }
        }

        const bytes = await module.arrayBuffer();
        return await WebAssembly.instantiate(bytes, imports);
    } else {
        const instance = await WebAssembly.instantiate(module, imports);

        if (instance instanceof WebAssembly.Instance) {
            return { instance, module };
        } else {
            return instance;
        }
    }

    function expectedResponseType(type) {
        switch (type) {
            case 'basic': case 'cors': case 'default': return true;
        }
        return false;
    }
}

function initSync(module) {
    if (wasm !== undefined) return wasm;


    if (module !== undefined) {
        if (Object.getPrototypeOf(module) === Object.prototype) {
            ({module} = module)
        } else {
            console.warn('using deprecated parameters for `initSync()`; pass a single object instead')
        }
    }

    const imports = __wbg_get_imports();
    if (!(module instanceof WebAssembly.Module)) {
        module = new WebAssembly.Module(module);
    }
    const instance = new WebAssembly.Instance(module, imports);
    return __wbg_finalize_init(instance, module);
}

async function __wbg_init(module_or_path) {
    if (wasm !== undefined) return wasm;


    if (module_or_path !== undefined) {
        if (Object.getPrototypeOf(module_or_path) === Object.prototype) {
            ({module_or_path} = module_or_path)
        } else {
            console.warn('using deprecated parameters for the initialization function; pass a single object instead')
        }
    }

    if (module_or_path === undefined) {
        module_or_path = new URL('openmls_wasm_bg.wasm', import.meta.url);
    }
    const imports = __wbg_get_imports();

    if (typeof module_or_path === 'string' || (typeof Request === 'function' && module_or_path instanceof Request) || (typeof URL === 'function' && module_or_path instanceof URL)) {
        module_or_path = fetch(module_or_path);
    }

    const { instance, module } = await __wbg_load(await module_or_path, imports);

    return __wbg_finalize_init(instance, module);
}

export { initSync, __wbg_init as default };
