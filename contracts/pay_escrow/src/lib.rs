#![no_std]

use soroban_sdk::{
    contract, contractclient, contractevent, contractimpl, contracttype, token, Address, BytesN, Env,
};

const MAX_EXPIRY_SECONDS: u64 = 30 * 24 * 60 * 60;

#[contractclient(name = "RegistryClient")]
pub trait Registry {
    fn resolve(env: Env, hash: BytesN<32>) -> Option<Address>;
}

#[contracttype]
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum PaymentStatus {
    Pending,
    Claimed,
    Refunded,
}

#[contracttype]
#[derive(Clone)]
pub struct Payment {
    pub sender: Address,
    pub hash: BytesN<32>,
    pub token: Address,
    pub amount: i128,
    pub expires_at: u64,
    pub status: PaymentStatus,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Deposited {
    #[topic]
    pub id: u64,
    #[topic]
    pub sender: Address,
    #[topic]
    pub hash: BytesN<32>,
    #[topic]
    pub token: Address,
    pub amount: i128,
    pub expires_at: u64,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Claimed {
    #[topic]
    pub id: u64,
    #[topic]
    pub recipient: Address,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Refunded {
    #[topic]
    pub id: u64,
    #[topic]
    pub sender: Address,
}

#[contracttype]
pub enum DataKey {
    Admin,
    Registry,
    AllowedToken,
    MinimumAmount,
    NextId,
    Payment(u64),
}

#[contract]
pub struct PayEscrow;

#[contractimpl]
impl PayEscrow {
    pub fn init(
        env: Env,
        admin: Address,
        registry: Address,
        allowed_token: Address,
        minimum_amount: i128,
    ) {
        if env.storage().instance().has(&DataKey::Admin) {
            panic!("Already initialized");
        }
        if minimum_amount <= 0 {
            panic!("Minimum amount must be positive");
        }
        admin.require_auth();
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::Registry, &registry);
        env.storage().instance().set(&DataKey::AllowedToken, &allowed_token);
        env.storage().instance().set(&DataKey::MinimumAmount, &minimum_amount);
        env.storage().instance().set(&DataKey::NextId, &0u64);
    }

    pub fn deposit(
        env: Env,
        sender: Address,
        hash: BytesN<32>,
        token_address: Address,
        amount: i128,
        expires_at: u64,
    ) -> u64 {
        sender.require_auth();
        Self::assert_token_and_amount(&env, &token_address, amount);
        let now = env.ledger().timestamp();
        if expires_at <= now || expires_at > now + MAX_EXPIRY_SECONDS {
            panic!("Invalid expiry");
        }

        let id: u64 = env
            .storage()
            .instance()
            .get(&DataKey::NextId)
            .unwrap_or(0);
        let escrow_address = env.current_contract_address();
        token::TokenClient::new(&env, &token_address).transfer(
            &sender,
            &escrow_address,
            &amount,
        );

        let payment = Payment {
            sender: sender.clone(),
            hash,
            token: token_address,
            amount,
            expires_at,
            status: PaymentStatus::Pending,
        };
        env.storage().instance().set(&DataKey::Payment(id), &payment);
        env.storage().instance().set(&DataKey::NextId, &(id + 1));
        Deposited {
            id,
            sender,
            hash: payment.hash,
            token: payment.token,
            amount,
            expires_at,
        }
        .publish(&env);
        id
    }

    pub fn claim(env: Env, id: u64) {
        let key = DataKey::Payment(id);
        let mut payment: Payment = env
            .storage()
            .instance()
            .get(&key)
            .unwrap_or_else(|| panic!("Payment not found"));
        if payment.status != PaymentStatus::Pending {
            panic!("Payment already settled");
        }
        if env.ledger().timestamp() >= payment.expires_at {
            panic!("Payment expired");
        }

        let registry: Address = env
            .storage()
            .instance()
            .get(&DataKey::Registry)
            .unwrap_or_else(|| panic!("Not initialized"));
        let recipient = RegistryClient::new(&env, &registry)
            .resolve(&payment.hash)
            .unwrap_or_else(|| panic!("Recipient is not registered"));
        recipient.require_auth();

        token::TokenClient::new(&env, &payment.token).transfer(
            &env.current_contract_address(),
            &recipient,
            &payment.amount,
        );
        payment.status = PaymentStatus::Claimed;
        env.storage().instance().set(&key, &payment);
        Claimed { id, recipient }.publish(&env);
    }

    pub fn refund(env: Env, id: u64) {
        let key = DataKey::Payment(id);
        let mut payment: Payment = env
            .storage()
            .instance()
            .get(&key)
            .unwrap_or_else(|| panic!("Payment not found"));
        if payment.status != PaymentStatus::Pending {
            panic!("Payment already settled");
        }
        if env.ledger().timestamp() < payment.expires_at {
            panic!("Payment not expired");
        }
        payment.sender.require_auth();

        token::TokenClient::new(&env, &payment.token).transfer(
            &env.current_contract_address(),
            &payment.sender,
            &payment.amount,
        );
        payment.status = PaymentStatus::Refunded;
        env.storage().instance().set(&key, &payment);
        Refunded {
            id,
            sender: payment.sender,
        }
        .publish(&env);
    }

    pub fn get_payment(env: Env, id: u64) -> Option<Payment> {
        env.storage().instance().get(&DataKey::Payment(id))
    }

    fn assert_token_and_amount(env: &Env, token_address: &Address, amount: i128) {
        let allowed_token: Address = env
            .storage()
            .instance()
            .get(&DataKey::AllowedToken)
            .unwrap_or_else(|| panic!("Not initialized"));
        if *token_address != allowed_token {
            panic!("Token is not allowed");
        }
        let minimum_amount: i128 = env
            .storage()
            .instance()
            .get(&DataKey::MinimumAmount)
            .unwrap_or_else(|| panic!("Not initialized"));
        if amount < minimum_amount {
            panic!("Amount below minimum");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use soroban_sdk::{testutils::Ledger, token::StellarAssetClient, Address};

    const TEST_ADDRESS: &str = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";
    const MINIMUM: i128 = 100;

    #[contract]
    pub struct RegistryMock;

    #[contract]
    pub struct SenderMock;

    #[contractimpl]
    impl RegistryMock {
        pub fn resolve(_env: Env, hash: BytesN<32>) -> Option<Address> {
            if hash == BytesN::from_array(&_env, &[9; 32]) {
                Some(_env.current_contract_address())
            } else {
                None
            }
        }
    }

    fn setup() -> (
        Env,
        PayEscrowClient<'static>,
        token::TokenClient<'static>,
        Address,
        Address,
    ) {
        let env = Env::default();
        let admin = Address::from_str(&env, TEST_ADDRESS);
        let registry_id = env.register(RegistryMock, ());
        let token_contract = env.register_stellar_asset_contract_v2(admin.clone());
        let token_id = token_contract.address();
        let escrow_id = env.register(PayEscrow, ());
        let sender_id = env.register(SenderMock, ());
        let escrow = PayEscrowClient::new(&env, &escrow_id);
        let token = token::TokenClient::new(&env, &token_id);
        env.mock_all_auths();
        escrow.init(&admin, &registry_id, &token_id, &MINIMUM);
        StellarAssetClient::new(&env, &token_id).mint(&sender_id, &1000);
        (env, escrow, token, sender_id, registry_id)
    }

    #[test]
    fn deposit_and_claim_transfers_funds() {
        let (env, escrow, token, sender, recipient) = setup();
        let hash = BytesN::from_array(&env, &[9; 32]);
        let id = escrow.deposit(&sender, &hash, &token.address, &250, &1000);

        escrow.claim(&id);

        assert_eq!(token.balance(&sender), 750);
        assert_eq!(token.balance(&recipient), 250);
        assert_eq!(escrow.get_payment(&id).unwrap().status, PaymentStatus::Claimed);
    }

    #[test]
    #[should_panic(expected = "Recipient is not registered")]
    fn unregistered_recipient_cannot_claim() {
        let (env, escrow, token, sender, _) = setup();
        let hash = BytesN::from_array(&env, &[1; 32]);
        let id = escrow.deposit(&sender, &hash, &token.address, &250, &1000);
        escrow.claim(&id);
    }

    #[test]
    fn expired_payment_refunds_sender() {
        let (env, escrow, token, sender, _) = setup();
        let hash = BytesN::from_array(&env, &[1; 32]);
        let id = escrow.deposit(&sender, &hash, &token.address, &250, &1000);
        env.ledger().set_timestamp(1000);

        escrow.refund(&id);

        assert_eq!(token.balance(&sender), 1000);
        assert_eq!(escrow.get_payment(&id).unwrap().status, PaymentStatus::Refunded);
    }
}
