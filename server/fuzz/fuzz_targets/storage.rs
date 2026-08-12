#![no_main]

use libfuzzer_sys::fuzz_target;

fuzz_target!(|bytes: &[u8]| {
    realtime_server::crdt_storage::fuzz_storage_bytes(bytes);
});
