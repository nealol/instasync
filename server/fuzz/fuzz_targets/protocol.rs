#![no_main]

use libfuzzer_sys::fuzz_target;

fuzz_target!(|bytes: &[u8]| {
    realtime_server::crdt::fuzz_protocol_bytes(bytes);
    realtime_server::dmux::fuzz_parse_frame(bytes);
});
