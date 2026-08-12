use std::path::Path;
use std::time::{Duration, Instant};

use realtime_server::crdt::DocumentStore;
use serde_json::json;
use tokio::io::AsyncWriteExt;
use tokio::task::JoinSet;
use yrs::updates::decoder::Decode;
use yrs::{Doc, Map, ReadTxn, StateVector, Transact, Update};

#[derive(Clone, Copy)]
struct Config {
    documents: usize,
    rounds: usize,
    restart_every: usize,
    compact: bool,
    inject_torn_tail: bool,
}

impl Config {
    fn from_env() -> Self {
        Self {
            documents: env_usize("RT_SOAK_DOCUMENTS", 128).max(1),
            rounds: env_usize("RT_SOAK_ROUNDS", 10).max(1),
            restart_every: env_usize("RT_SOAK_RESTART_EVERY", 5),
            compact: std::env::var("RT_SOAK_COMPACT")
                .map(|value| value != "0")
                .unwrap_or(true),
            inject_torn_tail: std::env::var("RT_SOAK_INJECT_TORN_TAIL")
                .map(|value| value != "0")
                .unwrap_or(true),
        }
    }
}

fn env_usize(name: &str, default: usize) -> usize {
    std::env::var(name)
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(default)
}

fn env_f64(name: &str) -> Option<f64> {
    std::env::var(name)
        .ok()
        .and_then(|value| value.parse().ok())
}

fn update(round: usize, document: usize) -> Vec<u8> {
    let doc = Doc::new();
    doc.get_or_insert_map("soak").insert(
        &mut doc.transact_mut(),
        format!("round-{round}"),
        format!("document-{document}"),
    );
    let encoded = doc
        .transact()
        .encode_state_as_update_v1(&StateVector::default());
    encoded
}

fn percentile(samples: &[Duration], percentile: usize) -> f64 {
    let index = (samples.len().saturating_sub(1) * percentile) / 100;
    samples[index].as_secs_f64() * 1_000.0
}

fn directory_bytes(path: &Path) -> u64 {
    std::fs::read_dir(path)
        .into_iter()
        .flatten()
        .flatten()
        .map(|entry| {
            let path = entry.path();
            if path.is_dir() {
                directory_bytes(&path)
            } else {
                entry.metadata().map(|metadata| metadata.len()).unwrap_or(0)
            }
        })
        .sum()
}

fn assert_budget(name: &str, observed: f64, limit: Option<f64>) {
    if let Some(limit) = limit {
        assert!(
            observed <= limit,
            "{name} {observed:.2}ms exceeded configured limit {limit:.2}ms"
        );
    }
}

async fn inject_torn_tail(root: &Path, document_id: &str) {
    let directory = root.join(format!("{document_id}.crdt"));
    let manifest: serde_json::Value = serde_json::from_slice(
        &tokio::fs::read(directory.join("manifest.json"))
            .await
            .expect("storage manifest"),
    )
    .expect("valid storage manifest");
    let updates = manifest["updates"]
        .as_str()
        .expect("storage manifest update segment");
    let mut file = tokio::fs::OpenOptions::new()
        .append(true)
        .open(directory.join(updates))
        .await
        .expect("update segment");
    // A process killed midway through the eight-byte record length leaves this
    // exact shape. Startup must truncate it without losing prior records.
    file.write_all(&[0xfa, 0x17, 0x00, 0x01, 0x02])
        .await
        .expect("partial update record");
    file.sync_all().await.expect("partial record fsync");
}

fn main() {
    let runtime = tokio::runtime::Runtime::new().expect("Tokio runtime");
    runtime.block_on(async {
        let config = Config::from_env();
        let root =
            std::env::temp_dir().join(format!("realtime-sync-soak-{}", uuid::Uuid::new_v4()));
        let mut store = DocumentStore::new(&root).await.expect("document store");
        let mut acknowledgements = Vec::with_capacity(config.documents * config.rounds);
        let mut restart_samples = Vec::new();
        let mut torn_tail_recoveries = 0usize;
        let started = Instant::now();

        for round in 0..config.rounds {
            let mut tasks = JoinSet::new();
            for document in 0..config.documents {
                let store = store.clone();
                tasks.spawn(async move {
                    let update = update(round, document);
                    let write_started = Instant::now();
                    store
                        .apply_update(&format!("soak__{document}"), &update)
                        .await
                        .expect("durable CRDT update");
                    write_started.elapsed()
                });
            }
            while let Some(result) = tasks.join_next().await {
                acknowledgements.push(result.expect("write task"));
            }

            if config.restart_every > 0
                && (round + 1) % config.restart_every == 0
                && round + 1 < config.rounds
            {
                drop(store);
                let fault_document = format!("soak__{}", round % config.documents);
                if config.inject_torn_tail {
                    inject_torn_tail(&root, &fault_document).await;
                    torn_tail_recoveries += 1;
                }
                let restart_started = Instant::now();
                store = DocumentStore::new(&root).await.expect("restarted document store");
                store
                    .read_update(&fault_document)
                    .await
                    .expect("torn update tail recovery");
                for document in [0, config.documents / 2, config.documents - 1] {
                    store
                        .read_update(&format!("soak__{document}"))
                        .await
                        .expect("cold document reload");
                }
                restart_samples.push(restart_started.elapsed());
            }
        }

        acknowledgements.sort_unstable();
        restart_samples.sort_unstable();

        for document in [0, config.documents / 2, config.documents - 1] {
            let state = store
                .read_update(&format!("soak__{document}"))
                .await
                .expect("final document state");
            let decoded = Update::decode_v1(&state).expect("valid final update");
            let doc = Doc::new();
            doc.transact_mut().apply_update(decoded);
            let map = doc.get_or_insert_map("soak");
            assert_eq!(
                map.len(&doc.transact()) as usize,
                config.rounds,
                "restart lost an acknowledged update for document {document}"
            );
        }

        let compact_started = Instant::now();
        if config.compact {
            let mut tasks = JoinSet::new();
            for document in 0..config.documents {
                let store = store.clone();
                tasks.spawn(async move {
                    store
                        .compact_document(&format!("soak__{document}"))
                        .await
                        .expect("document compaction");
                });
            }
            while let Some(result) = tasks.join_next().await {
                result.expect("compaction task");
            }
        }
        let compact_ms = compact_started.elapsed().as_secs_f64() * 1_000.0;
        let p99_ack_ms = percentile(&acknowledgements, 99);
        let max_restart_ms = restart_samples
            .iter()
            .map(|sample| sample.as_secs_f64() * 1_000.0)
            .fold(0.0, f64::max);
        let elapsed_ms = started.elapsed().as_secs_f64() * 1_000.0;
        let writes = config.documents * config.rounds;
        let writes_per_second = writes as f64 / started.elapsed().as_secs_f64();

        assert_budget("p99 acknowledgement", p99_ack_ms, env_f64("RT_SOAK_MAX_P99_ACK_MS"));
        assert_budget(
            "maximum sampled restart",
            max_restart_ms,
            env_f64("RT_SOAK_MAX_RESTART_MS"),
        );
        if let Some(minimum) = env_f64("RT_SOAK_MIN_WRITES_PER_SECOND") {
            assert!(
                writes_per_second >= minimum,
                "throughput {writes_per_second:.2} writes/s was below configured minimum {minimum:.2}"
            );
        }

        println!(
            "{}",
            serde_json::to_string_pretty(&json!({
                "configuration": {
                    "documents": config.documents,
                    "rounds": config.rounds,
                    "restartEveryRounds": config.restart_every,
                    "compact": config.compact,
                    "injectTornTail": config.inject_torn_tail,
                },
                "writes": writes,
                "elapsedMs": elapsed_ms,
                "writesPerSecond": writes_per_second,
                "acknowledgementLatencyMs": {
                    "p50": percentile(&acknowledgements, 50),
                    "p95": percentile(&acknowledgements, 95),
                    "p99": p99_ack_ms,
                    "max": percentile(&acknowledgements, 100),
                },
                "restart": {
                    "samples": restart_samples.len(),
                    "tornTailRecoveries": torn_tail_recoveries,
                    "p95Ms": if restart_samples.is_empty() { 0.0 } else { percentile(&restart_samples, 95) },
                    "maxMs": max_restart_ms,
                },
                "parallelCompactionMs": compact_ms,
                "storeBytes": directory_bytes(&root),
            }))
            .expect("benchmark JSON")
        );
        let _ = tokio::fs::remove_dir_all(root).await;
    });
}
