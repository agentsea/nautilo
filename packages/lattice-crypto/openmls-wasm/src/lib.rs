//! Vendored, extended wasm-bindgen wrapper over OpenMLS.
//!
//! Derived from `openmls/openmls` tag `openmls-v0.8.1`, commit
//! `47dbedecad0c1fd8eb5368d582250ebfcc1e1ce6`, `openmls-wasm/src/lib.rs` (MIT),
//! then modified by the lattice-lab and Nautilo projects. See
//! `../THIRD_PARTY_NOTICES.md`. The wrapper is trimmed to exactly the surface
//! the lattice `GroupKeyProvider` needs, plus the high-level commit operations
//! the upstream wrapper is missing: `propose_and_commit_update` and
//! `propose_and_commit_remove`. This crate is NEVER published; its `wasm-pack`
//! output is vendored into `../vendor/openmls-wasm/` and imported directly.
//!
//! Ciphersuite is fixed to the RFC 9420 mandatory-to-implement suite
//! (X25519 + ChaCha20-Poly1305 + Ed25519), matching upstream, to keep the
//! binary small and avoid negotiation.

mod utils;

use std::collections::HashMap;

use js_sys::Uint8Array;
use openmls::{
    credentials::{BasicCredential, CredentialWithKey},
    framing::{MlsMessageBodyIn, MlsMessageIn, MlsMessageOut},
    group::{GroupId, MlsGroup, MlsGroupJoinConfig, StagedWelcome},
    key_packages::KeyPackage as OpenMlsKeyPackage,
    prelude::{LeafNodeIndex, SignatureScheme},
    treesync::{LeafNodeParameters, RatchetTreeIn},
};
use openmls_basic_credential::SignatureKeyPair;
use openmls_rust_crypto::OpenMlsRustCrypto;
use openmls_traits::{types::Ciphersuite, OpenMlsProvider};
use tls_codec::{Deserialize, Serialize};
use wasm_bindgen::prelude::*;

/// Fixed to reduce binary size (upstream does the same).
static CIPHERSUITE: Ciphersuite = Ciphersuite::MLS_128_DHKEMX25519_CHACHA20POLY1305_SHA256_Ed25519;

/// A per-client crypto + storage provider (in-memory keystore). One per
/// simulated device on the TS side.
#[wasm_bindgen]
#[derive(Default)]
pub struct Provider(OpenMlsRustCrypto);

impl AsRef<OpenMlsRustCrypto> for Provider {
    fn as_ref(&self) -> &OpenMlsRustCrypto {
        &self.0
    }
}

#[wasm_bindgen]
impl Provider {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Self {
        utils::set_panic_hook();
        Self::default()
    }

    /// Device-local backup material. This contains the complete OpenMLS
    /// keystore and MUST be encrypted by the TypeScript device vault before it
    /// reaches durable storage. The public TypeScript provider never exposes
    /// these raw bytes as server state.
    pub fn serialize_device_state(&self) -> Result<Vec<u8>, JsError> {
        const MAX_ENTRIES: usize = 1_000_000;
        const MAX_STATE_BYTES: usize = 16 * 1024 * 1024;
        let values = self
            .0
            .storage()
            .values
            .read()
            .map_err(|_| JsError::new("provider storage lock poisoned"))?;
        if values.len() > MAX_ENTRIES {
            return Err(JsError::new("device state contains too many entries"));
        }
        let mut buf = Vec::new();
        buf.extend_from_slice(&(values.len() as u32).to_le_bytes());
        for (key, value) in values.iter() {
            let next_len = buf
                .len()
                .checked_add(8)
                .and_then(|len| len.checked_add(key.len()))
                .and_then(|len| len.checked_add(value.len()))
                .ok_or_else(|| JsError::new("device state size overflow"))?;
            if next_len > MAX_STATE_BYTES {
                return Err(JsError::new("device state exceeds size limit"));
            }
            buf.extend_from_slice(&(key.len() as u32).to_le_bytes());
            buf.extend_from_slice(key);
            buf.extend_from_slice(&(value.len() as u32).to_le_bytes());
            buf.extend_from_slice(value);
        }
        Ok(buf)
    }

    /// Restore device-local state previously returned by
    /// `serialize_device_state`. Enforces exact, bounded parsing.
    pub fn deserialize_device_state(bytes: &[u8]) -> Result<Provider, JsError> {
        const MAX_ENTRIES: usize = 1_000_000;
        const MAX_STATE_BYTES: usize = 16 * 1024 * 1024;
        if bytes.len() > MAX_STATE_BYTES {
            return Err(JsError::new("device state exceeds size limit"));
        }
        let mut position = 0usize;
        let count = read_u32(bytes, &mut position)? as usize;
        if count > MAX_ENTRIES {
            return Err(JsError::new("device state contains too many entries"));
        }
        let mut values = HashMap::with_capacity(count);
        for _ in 0..count {
            let key_len = read_u32(bytes, &mut position)? as usize;
            let key = read_slice(bytes, &mut position, key_len)?;
            let value_len = read_u32(bytes, &mut position)? as usize;
            let value = read_slice(bytes, &mut position, value_len)?;
            values.insert(key, value);
        }
        if position != bytes.len() {
            return Err(JsError::new("device state contains trailing bytes"));
        }
        let provider = Provider::default();
        {
            let mut destination = provider
                .0
                .storage()
                .values
                .write()
                .map_err(|_| JsError::new("provider storage lock poisoned"))?;
            *destination = values;
        }
        Ok(provider)
    }
}

/// A signing identity (BasicCredential + Ed25519 keypair).
#[wasm_bindgen]
pub struct Identity {
    credential_with_key: CredentialWithKey,
    keypair: SignatureKeyPair,
}

#[wasm_bindgen]
impl Identity {
    #[wasm_bindgen(constructor)]
    pub fn new(provider: &Provider, name: &str) -> Result<Identity, JsError> {
        let keypair = SignatureKeyPair::new(SignatureScheme::ED25519)?;
        keypair.store(provider.0.storage())?;
        let credential = BasicCredential::new(name.bytes().collect());
        let credential_with_key = CredentialWithKey {
            credential: credential.into(),
            signature_key: keypair.public().into(),
        };
        Ok(Identity {
            credential_with_key,
            keypair,
        })
    }

    pub fn key_package(&self, provider: &Provider) -> Result<KeyPackage, JsError> {
        let kp = OpenMlsKeyPackage::builder()
            .build(
                CIPHERSUITE,
                &provider.0,
                &self.keypair,
                self.credential_with_key.clone(),
            )
            .map_err(|e| JsError::new(&format!("key package build error: {e}")))?;
        Ok(KeyPackage(kp.key_package().clone()))
    }

    /// Rehydrate the committing identity from a restored device keystore and
    /// its own authenticated leaf. This makes restart restore fully
    /// operational, rather than exporter-only.
    pub fn load(provider: &Provider, group: &Group) -> Result<Identity, JsError> {
        let own_leaf = group
            .mls_group
            .own_leaf_node()
            .ok_or_else(|| JsError::new("restored group has no own leaf"))?;
        let signature_key = own_leaf.signature_key();
        let keypair = SignatureKeyPair::read(
            provider.0.storage(),
            signature_key.as_slice(),
            group.mls_group.ciphersuite().signature_algorithm(),
        )
        .ok_or_else(|| JsError::new("restored keystore has no signing key"))?;
        Ok(Identity {
            credential_with_key: CredentialWithKey::from(own_leaf),
            keypair,
        })
    }
}

/// Messages produced by an Add commit: the proposal + commit (to fan out to
/// existing members) + the welcome (to onboard the new member).
#[wasm_bindgen]
pub struct AddMessages {
    commit: Uint8Array,
    welcome: Uint8Array,
}

#[wasm_bindgen]
impl AddMessages {
    #[wasm_bindgen(getter)]
    pub fn commit(&self) -> Uint8Array {
        self.commit.clone()
    }
    #[wasm_bindgen(getter)]
    pub fn welcome(&self) -> Uint8Array {
        self.welcome.clone()
    }
}

/// === ADDED (not in upstream openmls-wasm) ===
/// Message produced by an RFC 9420 self-update commit. The caller must merge
/// the pending commit locally and fan out `commit` to the other members.
#[wasm_bindgen]
pub struct UpdateMessages {
    commit: Uint8Array,
}

#[wasm_bindgen]
impl UpdateMessages {
    #[wasm_bindgen(getter)]
    pub fn commit(&self) -> Uint8Array {
        self.commit.clone()
    }
}

/// === ADDED (not in upstream openmls-wasm) ===
/// Messages produced by a Remove commit: proposal + commit. There is no welcome
/// on removal. Fanning out `commit` to the remaining members advances their MLS
/// epoch; the lattice epoch bump happens on the TS side.
#[wasm_bindgen]
pub struct RemoveMessages {
    commit: Uint8Array,
}

#[wasm_bindgen]
impl RemoveMessages {
    #[wasm_bindgen(getter)]
    pub fn commit(&self) -> Uint8Array {
        self.commit.clone()
    }
}

#[wasm_bindgen]
pub struct Group {
    mls_group: MlsGroup,
}

#[wasm_bindgen]
impl Group {
    pub fn create_new(
        provider: &Provider,
        founder: &Identity,
        group_id: &str,
    ) -> Result<Group, JsError> {
        let mls_group = MlsGroup::builder()
            .ciphersuite(CIPHERSUITE)
            .with_group_id(GroupId::from_slice(group_id.as_bytes()))
            .build(
                &provider.0,
                &founder.keypair,
                founder.credential_with_key.clone(),
            )
            .map_err(|e| JsError::new(&format!("group build error: {e}")))?;
        Ok(Group { mls_group })
    }

    pub fn join(
        provider: &Provider,
        welcome: &[u8],
        ratchet_tree: &RatchetTree,
    ) -> Result<Group, JsError> {
        let welcome = match MlsMessageIn::tls_deserialize_exact(welcome)?.extract() {
            MlsMessageBodyIn::Welcome(welcome) => welcome,
            other => return Err(JsError::new(&format!("expected welcome, got {other:?}"))),
        };
        let config = MlsGroupJoinConfig::builder().build();
        let mls_group = StagedWelcome::new_from_welcome(
            &provider.0,
            &config,
            welcome,
            Some(ratchet_tree.0.clone()),
        )?
        .into_group(&provider.0)?;
        Ok(Group { mls_group })
    }

    /// Rehydrate a group handle from the encrypted device-local provider
    /// backup. This is deliberately not usable with public Delivery Service
    /// state alone.
    pub fn load_device_state(provider: &Provider, group_id: &str) -> Result<Group, JsError> {
        let group_id = GroupId::from_slice(group_id.as_bytes());
        let mls_group = MlsGroup::load(provider.0.storage(), &group_id)
            .map_err(|error| JsError::new(&format!("group load: {error:?}")))?
            .ok_or_else(|| JsError::new("group not found in device state"))?;
        Ok(Group { mls_group })
    }

    pub fn export_ratchet_tree(&self) -> RatchetTree {
        RatchetTree(self.mls_group.export_ratchet_tree().into())
    }

    /// The leaf index assigned by OpenMLS to this member. Adds reuse the
    /// leftmost blank leaf, so callers must never synthesize this value.
    pub fn own_leaf_index(&self) -> u32 {
        self.mls_group.own_leaf_index().u32()
    }

    /// Authoritative public roster as a compact length-framed byte sequence:
    /// count:u32, then repeated (leaf_index:u32, identity_len:u32, identity).
    /// Basic credential identities are device IDs in the TypeScript provider.
    pub fn member_roster(&self) -> Vec<u8> {
        let members: Vec<_> = self.mls_group.members().collect();
        let mut out = Vec::new();
        out.extend_from_slice(&(members.len() as u32).to_le_bytes());
        for member in members {
            let identity = member.credential.serialized_content();
            out.extend_from_slice(&member.index.u32().to_le_bytes());
            out.extend_from_slice(&(identity.len() as u32).to_le_bytes());
            out.extend_from_slice(identity);
        }
        out
    }

    /// Create a real RFC 9420 self-update commit with a freshly generated leaf
    /// encryption key. OpenMLS stages the commit; callers decide when to merge
    /// it through `merge_pending_commit`.
    pub fn propose_and_commit_update(
        &mut self,
        provider: &Provider,
        sender: &Identity,
    ) -> Result<UpdateMessages, JsError> {
        if self.mls_group.has_pending_proposals() {
            return Err(JsError::new(
                "self-update requires an empty pending proposal queue",
            ));
        }
        let bundle = self.mls_group.self_update(
            &provider.0,
            &sender.keypair,
            LeafNodeParameters::default(),
        )?;
        let (commit_msg, _welcome, _group_info) = bundle.into_contents();
        Ok(UpdateMessages {
            commit: to_uint8array(&commit_msg),
        })
    }

    pub fn propose_and_commit_add(
        &mut self,
        provider: &Provider,
        sender: &Identity,
        new_member: &KeyPackage,
    ) -> Result<AddMessages, JsError> {
        // High-level add: the returned commit INLINES the add proposal, so other
        // members can process it directly (no separate proposal fan-out).
        let (commit_msg, welcome_msg, _group_info) = self.mls_group.add_members(
            &provider.0,
            &sender.keypair,
            std::slice::from_ref(&new_member.0),
        )?;
        Ok(AddMessages {
            commit: to_uint8array(&commit_msg),
            welcome: to_uint8array(&welcome_msg),
        })
    }

    /// === ADDED (not in upstream openmls-wasm) ===
    /// Propose + commit removal of the member at `removed_index` (its MLS leaf
    /// index). Mirrors `propose_and_commit_add`; produces no welcome.
    pub fn propose_and_commit_remove(
        &mut self,
        provider: &Provider,
        sender: &Identity,
        removed_index: u32,
    ) -> Result<RemoveMessages, JsError> {
        // High-level remove: commit INLINES the remove proposal (no welcome).
        let (commit_msg, _welcome, _group_info) = self.mls_group.remove_members(
            &provider.0,
            &sender.keypair,
            &[LeafNodeIndex::new(removed_index)],
        )?;
        Ok(RemoveMessages {
            commit: to_uint8array(&commit_msg),
        })
    }

    pub fn merge_pending_commit(&mut self, provider: &Provider) -> Result<(), JsError> {
        self.mls_group
            .merge_pending_commit(&provider.0)
            .map_err(|e| e.into())
    }

    /// Apply an incoming proposal or commit. Application messages return their
    /// plaintext; proposals/commits are staged/merged and return an empty array.
    pub fn process_message(&mut self, provider: &Provider, msg: &[u8]) -> Result<Vec<u8>, JsError> {
        let msg = MlsMessageIn::tls_deserialize_exact(msg)?;
        let processed = match msg.extract() {
            MlsMessageBodyIn::PublicMessage(m) => self.mls_group.process_message(&provider.0, m)?,
            MlsMessageBodyIn::PrivateMessage(m) => {
                self.mls_group.process_message(&provider.0, m)?
            }
            other => {
                return Err(JsError::new(&format!(
                    "cannot process message body {other:?}"
                )))
            }
        };
        match processed.into_content() {
            openmls::framing::ProcessedMessageContent::ApplicationMessage(app) => {
                Ok(app.into_bytes())
            }
            openmls::framing::ProcessedMessageContent::ProposalMessage(p)
            | openmls::framing::ProcessedMessageContent::ExternalJoinProposalMessage(p) => {
                self.mls_group
                    .store_pending_proposal(provider.0.storage(), *p)?;
                Ok(vec![])
            }
            openmls::framing::ProcessedMessageContent::StagedCommitMessage(staged) => {
                self.mls_group.merge_staged_commit(&provider.0, *staged)?;
                Ok(vec![])
            }
        }
    }

    /// The MLS exporter secret — the lattice's single integration point.
    pub fn export_key(
        &self,
        provider: &Provider,
        label: &str,
        context: &[u8],
        key_length: usize,
    ) -> Result<Vec<u8>, JsError> {
        self.mls_group
            .export_secret(provider.0.crypto(), label, context, key_length)
            .map_err(|e| JsError::new(&format!("export secret error: {e}")))
    }
}

#[wasm_bindgen]
pub struct KeyPackage(OpenMlsKeyPackage);

#[wasm_bindgen]
impl KeyPackage {
    pub fn to_bytes(&self) -> Result<Vec<u8>, JsError> {
        self.0.tls_serialize_detached().map_err(|e| e.into())
    }

    pub fn from_bytes(bytes: &[u8]) -> Result<KeyPackage, JsError> {
        let kp_in = openmls::key_packages::KeyPackageIn::tls_deserialize_exact(bytes)?;
        let kp = kp_in
            .validate(
                &openmls_rust_crypto::RustCrypto::default(),
                openmls::prelude::ProtocolVersion::Mls10,
            )
            .map_err(|e| JsError::new(&format!("key package validation error: {e}")))?;
        Ok(KeyPackage(kp))
    }
}

#[wasm_bindgen]
pub struct RatchetTree(RatchetTreeIn);

#[wasm_bindgen]
impl RatchetTree {
    pub fn to_bytes(&self) -> Result<Vec<u8>, JsError> {
        self.0.tls_serialize_detached().map_err(|e| e.into())
    }

    pub fn from_bytes(bytes: &[u8]) -> Result<RatchetTree, JsError> {
        Ok(RatchetTree(RatchetTreeIn::tls_deserialize_exact(bytes)?))
    }
}

fn to_uint8array(msg: &MlsMessageOut) -> Uint8Array {
    let mut serialized = vec![];
    msg.tls_serialize(&mut serialized)
        .expect("serialize MlsMessageOut");
    // SAFETY: copy out immediately; see wasm-bindgen#1619.
    unsafe { Uint8Array::new(&Uint8Array::view(&serialized)) }
}

fn read_u32(bytes: &[u8], position: &mut usize) -> Result<u32, JsError> {
    let value = read_slice(bytes, position, 4)?;
    Ok(u32::from_le_bytes(value.try_into().map_err(|_| {
        JsError::new("device state has invalid u32")
    })?))
}

fn read_slice(bytes: &[u8], position: &mut usize, length: usize) -> Result<Vec<u8>, JsError> {
    let end = position
        .checked_add(length)
        .ok_or_else(|| JsError::new("device state length overflow"))?;
    if end > bytes.len() {
        return Err(JsError::new("device state is truncated"));
    }
    let value = bytes[*position..end].to_vec();
    *position = end;
    Ok(value)
}
