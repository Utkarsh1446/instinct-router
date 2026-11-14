use near_sdk::borsh::{BorshDeserialize, BorshSerialize};
use near_sdk::serde::{Deserialize, Serialize};
use near_sdk::{env, near_bindgen, AccountId, PanicOnDefault};

const MAX_DECISIONS: usize = 64;

/// One routing decision. The quote hash is the SHA-256 hex of the 1Click
/// economic binding produced by `nearIntentsQuoteCanonical`. This contract
/// stores that commitment. It does not receive swap funds.
#[derive(BorshDeserialize, BorshSerialize, Serialize, Deserialize, Clone, PartialEq, Debug)]
#[borsh(crate = "near_sdk::borsh")]
#[serde(crate = "near_sdk::serde")]
pub struct Decision {
    pub route_id: String,
    pub quote_hash: String,
    pub provider_id: String,
    pub expected_out: String,
    pub minimum_out: String,
    pub fee_bps: u32,
    pub eta_ms: u64,
    pub objective: String,
    pub recorded_by: AccountId,
    pub recorded_at_ms: u64,
}

#[near_bindgen]
#[derive(BorshDeserialize, BorshSerialize, PanicOnDefault)]
#[borsh(crate = "near_sdk::borsh")]
pub struct RouteAudit {
    decisions: Vec<Decision>,
}

fn text(value: &str, max: usize) -> bool {
    !value.is_empty() && value.len() <= max && value.bytes().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'.' | b':' | b'-'))
}

fn raw_amount(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 78
        && value.bytes().all(|byte| byte.is_ascii_digit())
        && (value == "0" || !value.starts_with('0'))
}

#[near_bindgen]
impl RouteAudit {
    #[init]
    pub fn new() -> Self {
        Self { decisions: Vec::new() }
    }

    /// Append-only. A second write for the same route id is rejected.
    pub fn record_decision(
        &mut self,
        route_id: String,
        quote_hash: String,
        provider_id: String,
        expected_out: String,
        minimum_out: String,
        fee_bps: u32,
        eta_ms: u64,
        objective: String,
    ) -> Decision {
        if self.decisions.len() >= MAX_DECISIONS {
            env::panic_str("DECISION_LOG_FULL");
        }
        if !text(&route_id, 80) {
            env::panic_str("INVALID_ROUTE_ID");
        }
        if quote_hash.len() != 64 || !quote_hash.bytes().all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase()) {
            env::panic_str("INVALID_QUOTE_HASH");
        }
        if !text(&provider_id, 64) {
            env::panic_str("INVALID_PROVIDER");
        }
        if !raw_amount(&expected_out) || expected_out == "0" || !raw_amount(&minimum_out) || minimum_out == "0" {
            env::panic_str("INVALID_OUTPUT");
        }
        if minimum_out.len() > expected_out.len()
            || minimum_out.len() == expected_out.len() && minimum_out > expected_out
        {
            env::panic_str("INVALID_OUTPUT");
        }
        if fee_bps > 1_000_000 || eta_ms == 0 || eta_ms > 7 * 24 * 60 * 60 * 1000 {
            env::panic_str("INVALID_ECONOMICS");
        }
        if objective != "BALANCED" && objective != "BEST_OUTPUT" && objective != "FASTEST" {
            env::panic_str("INVALID_OBJECTIVE");
        }
        if self.decisions.iter().any(|row| row.route_id == route_id) {
            env::panic_str("DUPLICATE_ROUTE_ID");
        }
        let decision = Decision {
            route_id,
            quote_hash,
            provider_id,
            expected_out,
            minimum_out,
            fee_bps,
            eta_ms,
            objective,
            recorded_by: env::predecessor_account_id(),
            recorded_at_ms: env::block_timestamp_ms(),
        };
        self.decisions.push(decision.clone());
        decision
    }

    pub fn get_decision(&self, route_id: String) -> Option<Decision> {
        self.decisions.iter().find(|row| row.route_id == route_id).cloned()
    }

    pub fn list_decisions(&self, offset: u64, limit: u64) -> Vec<Decision> {
        if limit == 0 || limit > 32 {
            env::panic_str("INVALID_LIMIT");
        }
        let start = offset as usize;
        if start > self.decisions.len() {
            return Vec::new();
        }
        self.decisions.iter().skip(start).take(limit as usize).cloned().collect()
    }

    pub fn decision_count(&self) -> u64 {
        self.decisions.len() as u64
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::VMContextBuilder;
    use near_sdk::testing_env;

    fn hash() -> String {
        "92d58abe82db7e7ba35951f78c62d92703b7cecfa5b7105e33edbc6c25b3e693".to_string()
    }

    fn setup() -> RouteAudit {
        let context = VMContextBuilder::new()
            .predecessor_account_id("caller.testnet".parse().unwrap())
            .block_timestamp(1_700_000_000_000_000_000)
            .build();
        testing_env!(context);
        RouteAudit::new()
    }

    fn record(contract: &mut RouteAudit, route_id: &str) -> Decision {
        contract.record_decision(
            route_id.to_string(),
            hash(),
            "near-intents-1click".to_string(),
            "2020".to_string(),
            "2000".to_string(),
            20,
            45_000,
            "BEST_OUTPUT".to_string(),
        )
    }

    #[test]
    fn records_a_quote_hash_without_replacing_it() {
        let mut contract = setup();
        let saved = record(&mut contract, "compare-1");
        assert_eq!(saved.quote_hash, hash());
        assert_eq!(saved.provider_id, "near-intents-1click");
        let caller: AccountId = "caller.testnet".parse().unwrap();
        assert_eq!(saved.recorded_by, caller);
        assert_eq!(saved.recorded_at_ms, 1_700_000_000_000);
        assert_eq!(contract.decision_count(), 1);
        assert_eq!(contract.get_decision("compare-1".to_string()).unwrap().minimum_out, "2000");
        assert!(contract.get_decision("missing".to_string()).is_none());
    }

    #[test]
    #[should_panic(expected = "DUPLICATE_ROUTE_ID")]
    fn rejects_a_second_write_for_the_same_route() {
        let mut contract = setup();
        record(&mut contract, "compare-1");
        record(&mut contract, "compare-1");
    }

    #[test]
    #[should_panic(expected = "INVALID_QUOTE_HASH")]
    fn rejects_a_non_hex_hash() {
        let mut contract = setup();
        contract.record_decision(
            "compare-1".to_string(),
            "ZZ".repeat(32),
            "relay".to_string(),
            "10".to_string(),
            "9".to_string(),
            1,
            1,
            "FASTEST".to_string(),
        );
    }

    #[test]
    #[should_panic(expected = "INVALID_OUTPUT")]
    fn rejects_a_minimum_above_the_expected_output() {
        let mut contract = setup();
        contract.record_decision(
            "compare-1".to_string(),
            hash(),
            "relay".to_string(),
            "1999".to_string(),
            "2000".to_string(),
            1,
            1,
            "BALANCED".to_string(),
        );
    }

    #[test]
    fn lists_decisions_in_insertion_order() {
        let mut contract = setup();
        record(&mut contract, "a");
        record(&mut contract, "b");
        let page = contract.list_decisions(1, 1);
        assert_eq!(page.len(), 1);
        assert_eq!(page[0].route_id, "b");
    }
}
