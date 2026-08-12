use std::path::Path;
use std::time::{Duration, Instant};

use realtime_server::crdt::DocumentStore;
use serde_json::json;
use yrs::{Doc, Map, ReadTxn, StateVector, Transact};

fn update(key: &str, value: &str) -> Vec<u8> {
    let doc = Doc::new();
    doc.get_or_insert_map("bench")
        .insert(&mut doc.transact_mut(), key, value);
    let update = doc
        .transact()
        .encode_state_as_update_v1(&StateVector::default());
    update
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

fn percentile(samples: &[Duration], percentile: usize) -> f64 {
    let index = (samples.len().saturating_sub(1) * percentile) / 100;
    samples[index].as_secs_f64() * 1000.0
}

fn main() {
    let runtime = tokio::runtime::Runtime::new().expect("Tokio runtime");
    runtime.block_on(async {
        let root =
            std::env::temp_dir().join(format!("realtime-crdt-bench-{}", uuid::Uuid::new_v4()));
        let store = DocumentStore::new(&root).await.expect("document store");
        let document_id = "benchmark__primary";
        let base = "x".repeat(4 * 1024 * 1024);
        store
            .apply_update(document_id, &update("base", &base))
            .await
            .expect("seed document");
        store
            .compact_document(document_id)
            .await
            .expect("compact seed");
        let bytes_before = directory_bytes(&root);

        let mut acknowledgements = Vec::with_capacity(200);
        for index in 0..200 {
            let update = update(&format!("change-{index}"), &format!("value-{index}"));
            let started = Instant::now();
            store
                .apply_update(document_id, &update)
                .await
                .expect("append update");
            acknowledgements.push(started.elapsed());
        }
        acknowledgements.sort_unstable();
        let bytes_after_updates = directory_bytes(&root);

        let compact_started = Instant::now();
        store
            .compact_document(document_id)
            .await
            .expect("compact document");
        let compact_ms = compact_started.elapsed().as_secs_f64() * 1000.0;
        let bytes_after_compaction = directory_bytes(&root);

        drop(store);
        let cold_started = Instant::now();
        let reloaded = DocumentStore::new(&root).await.expect("reload store");
        reloaded
            .read_update(document_id)
            .await
            .expect("cold-load document");
        let cold_load_ms = cold_started.elapsed().as_secs_f64() * 1000.0;

        let concurrent_started = Instant::now();
        let mut writes = Vec::new();
        for index in 0..64 {
            let store = reloaded.clone();
            writes.push(tokio::spawn(async move {
                store
                    .apply_update(
                        &format!("parallel__{index}"),
                        &update("value", &index.to_string()),
                    )
                    .await
            }));
        }
        for write in writes {
            write.await.expect("write task").expect("parallel write");
        }
        let concurrent_ms = concurrent_started.elapsed().as_secs_f64() * 1000.0;

        println!(
            "{}",
            serde_json::to_string_pretty(&json!({
                "documentBytes": base.len(),
                "acknowledgementLatencyMs": {
                    "p50": percentile(&acknowledgements, 50),
                    "p95": percentile(&acknowledgements, 95),
                    "p99": percentile(&acknowledgements, 99),
                },
                "diskBytes": {
                    "beforeUpdates": bytes_before,
                    "after200Updates": bytes_after_updates,
                    "afterCompaction": bytes_after_compaction,
                },
                "compactionMs": compact_ms,
                "coldLoadMs": cold_load_ms,
                "concurrent64DocumentsMs": concurrent_ms,
            }))
            .expect("benchmark JSON")
        );
        let _ = tokio::fs::remove_dir_all(root).await;
    });
}
