#![no_std]

use soroban_sdk::{contract, contractimpl, contracttype, Address, BytesN, Env};

const COOLDOWN_SECONDS: u64 = 72 * 60 * 60;

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    Admin,
    Entry(BytesN<32>),
    Pending(BytesN<32>),
}

#[contracttype]
#[derive(Clone)]
pub struct PendingEntry {
    pub new_wallet: Address,
    pub ready_at: u64,
}

#[contract]
pub struct PhoneRegistry;

#[contractimpl]
impl PhoneRegistry {
    pub fn init(env: Env, admin: Address) {
        if env.storage().instance().has(&DataKey::Admin) {
            panic!("Already initialized");
        }
        admin.require_auth();
        env.storage().instance().set(&DataKey::Admin, &admin);
    }

    pub fn register(env: Env, hash: BytesN<32>, wallet: Address) {
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .unwrap_or_else(|| panic!("Not initialized"));
        admin.require_auth();

        let key = DataKey::Entry(hash);
        if env.storage().instance().has(&key) {
            panic!("Phone already registered");
        }
        env.storage().instance().set(&key, &wallet);
    }

    pub fn resolve(env: Env, hash: BytesN<32>) -> Option<Address> {
        env.storage().instance().get(&DataKey::Entry(hash))
    }

    pub fn propose_rebind(env: Env, hash: BytesN<32>, new_wallet: Address) {
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .unwrap_or_else(|| panic!("Not initialized"));
        admin.require_auth();

        if !env.storage().instance().has(&DataKey::Entry(hash.clone())) {
            panic!("Phone is not registered");
        }

        let pending = PendingEntry {
            new_wallet,
            ready_at: env.ledger().timestamp() + COOLDOWN_SECONDS,
        };
        env.storage()
            .instance()
            .set(&DataKey::Pending(hash), &pending);
    }

    pub fn cancel_rebind(env: Env, hash: BytesN<32>) {
        let entry_key = DataKey::Entry(hash.clone());
        let wallet: Address = env
            .storage()
            .instance()
            .get(&entry_key)
            .unwrap_or_else(|| panic!("Phone is not registered"));
        wallet.require_auth();
        env.storage().instance().remove(&DataKey::Pending(hash));
    }

    pub fn finalize_rebind(env: Env, hash: BytesN<32>) {
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .unwrap_or_else(|| panic!("Not initialized"));
        admin.require_auth();

        let pending_key = DataKey::Pending(hash.clone());
        let pending: PendingEntry = env
            .storage()
            .instance()
            .get(&pending_key)
            .unwrap_or_else(|| panic!("No pending rebind to finalize"));
        if env.ledger().timestamp() < pending.ready_at {
            panic!("Rebind not ready yet");
        }

        env.storage()
            .instance()
            .set(&DataKey::Entry(hash), &pending.new_wallet);
        env.storage().instance().remove(&pending_key);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use soroban_sdk::Address;

    const TEST_ADDRESS: &str = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";

    fn setup() -> (Env, PhoneRegistryClient<'static>, Address, Address) {
        let env = Env::default();
        let admin = Address::from_str(&env, TEST_ADDRESS);
        let wallet = Address::from_str(&env, TEST_ADDRESS);
        let contract_id = env.register(PhoneRegistry, ());
        let client = PhoneRegistryClient::new(&env, &contract_id);
        (env, client, admin, wallet)
    }

    #[test]
    fn register_and_resolve() {
        let (env, client, admin, wallet) = setup();
        let hash = BytesN::from_array(&env, &[1; 32]);
        env.mock_all_auths();
        client.init(&admin);
        client.register(&hash, &wallet);

        assert_eq!(client.resolve(&hash), Some(wallet));
    }

    #[test]
    #[should_panic(expected = "Phone already registered")]
    fn duplicate_registration_fails() {
        let (env, client, admin, wallet) = setup();
        let hash = BytesN::from_array(&env, &[2; 32]);
        env.mock_all_auths();
        client.init(&admin);
        client.register(&hash, &wallet);
        client.register(&hash, &wallet);
    }

    #[test]
    fn cancel_rebind_preserves_original_wallet() {
        let (env, client, admin, wallet) = setup();
        let hash = BytesN::from_array(&env, &[3; 32]);
        let replacement = Address::from_str(&env, TEST_ADDRESS);
        env.mock_all_auths();
        client.init(&admin);
        client.register(&hash, &wallet);
        client.propose_rebind(&hash, &replacement);
        client.cancel_rebind(&hash);

        assert_eq!(client.resolve(&hash), Some(wallet));
    }
}
