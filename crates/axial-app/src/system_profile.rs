//! Cached host capability detection for the optional machine card.

use std::collections::BTreeSet;
use std::fs;
use std::process::Command;
use std::sync::mpsc::{self, Receiver};
use std::thread;

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct SystemProfile {
    pub(crate) cpu: String,
    pub(crate) physical_cores: usize,
    pub(crate) logical_threads: usize,
    pub(crate) memory_bytes: u64,
    pub(crate) gpus: Vec<String>,
    pub(crate) os: String,
}

pub(crate) fn detect_async() -> Receiver<SystemProfile> {
    let (sender, receiver) = mpsc::channel();
    thread::spawn(move || {
        let _ = sender.send(detect());
    });
    receiver
}

fn detect() -> SystemProfile {
    let cpuinfo = fs::read_to_string("/proc/cpuinfo").unwrap_or_default();
    let meminfo = fs::read_to_string("/proc/meminfo").unwrap_or_default();
    let (cpu, physical_cores, logical_threads) = parse_cpuinfo(&cpuinfo);
    let memory_bytes = parse_memory_bytes(&meminfo);
    let gpus = Command::new("lspci")
        .arg("-nn")
        .output()
        .ok()
        .filter(|output| output.status.success())
        .map(|output| String::from_utf8_lossy(&output.stdout).into_owned())
        .map(|output| parse_gpus(&output))
        .filter(|gpus| !gpus.is_empty())
        .unwrap_or_else(nvidia_proc_gpus);
    let os_release = fs::read_to_string("/etc/os-release").unwrap_or_default();

    SystemProfile {
        cpu,
        physical_cores,
        logical_threads,
        memory_bytes,
        gpus,
        os: parse_os(&os_release),
    }
}

fn parse_cpuinfo(text: &str) -> (String, usize, usize) {
    let mut cpu = String::new();
    let mut logical_threads = 0;
    let mut cores = BTreeSet::new();

    for block in text.split("\n\n") {
        let mut physical_id = None;
        let mut core_id = None;
        let mut is_processor = false;
        for line in block.lines() {
            let Some((key, value)) = line.split_once(':') else {
                continue;
            };
            let key = key.trim();
            let value = value.trim();
            match key {
                "processor" => is_processor = true,
                "model name" | "Hardware" if cpu.is_empty() => cpu = value.into(),
                "physical id" => physical_id = Some(value.to_owned()),
                "core id" => core_id = Some(value.to_owned()),
                _ => {}
            }
        }
        if is_processor {
            logical_threads += 1;
            if let (Some(package), Some(core)) = (physical_id, core_id) {
                cores.insert((package, core));
            }
        }
    }

    let logical_threads = logical_threads.max(1);
    let physical_cores = if cores.is_empty() {
        logical_threads
    } else {
        cores.len()
    };
    if cpu.is_empty() {
        cpu = "Unknown CPU".into();
    }
    (cpu, physical_cores, logical_threads)
}

fn parse_memory_bytes(text: &str) -> u64 {
    text.lines()
        .find_map(|line| {
            let value = line.strip_prefix("MemTotal:")?;
            value
                .split_whitespace()
                .next()?
                .parse::<u64>()
                .ok()
                .map(|kib| kib * 1024)
        })
        .unwrap_or(0)
}

fn parse_gpus(text: &str) -> Vec<String> {
    text.lines()
        .filter(|line| {
            [
                "VGA compatible controller",
                "3D controller",
                "Display controller",
            ]
            .iter()
            .any(|kind| line.contains(kind))
        })
        .filter_map(|line| line.split_once("]: ").map(|(_, value)| value.trim()))
        .map(|value| value.trim_end_matches(|ch: char| ch == ')' || ch.is_ascii_hexdigit()))
        .map(|value| value.trim_end_matches(" (rev ").trim().to_owned())
        .filter(|value| !value.is_empty())
        .collect()
}

fn nvidia_proc_gpus() -> Vec<String> {
    let Ok(entries) = fs::read_dir("/proc/driver/nvidia/gpus") else {
        return Vec::new();
    };
    entries
        .flatten()
        .filter_map(|entry| fs::read_to_string(entry.path().join("information")).ok())
        .filter_map(|text| {
            text.lines()
                .find_map(|line| line.strip_prefix("Model:").map(str::trim))
                .map(str::to_owned)
        })
        .collect()
}

fn parse_os(text: &str) -> String {
    text.lines()
        .find_map(|line| line.strip_prefix("PRETTY_NAME="))
        .map(|value| value.trim_matches('"').to_owned())
        .unwrap_or_else(|| std::env::consts::OS.to_owned())
}

pub(crate) fn format_memory(bytes: u64) -> String {
    if bytes == 0 {
        return "Unknown".into();
    }
    format!("{:.1} GiB", bytes as f64 / 1024_f64.powi(3))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_cpu_topology_and_total_memory() {
        let cpuinfo = "processor: 0\nmodel name: Example 9000\nphysical id: 0\ncore id: 0\n\nprocessor: 1\nmodel name: Example 9000\nphysical id: 0\ncore id: 0\n\nprocessor: 2\nmodel name: Example 9000\nphysical id: 0\ncore id: 1\n";
        let (cpu, cores, threads) = parse_cpuinfo(cpuinfo);

        assert_eq!(cpu, "Example 9000");
        assert_eq!(cores, 2);
        assert_eq!(threads, 3);
        assert_eq!(parse_memory_bytes("MemTotal:       65536 kB\n"), 67_108_864);
    }

    #[test]
    fn extracts_display_adapters_and_formats_memory() {
        let adapters = parse_gpus(
            "01:00.0 VGA compatible controller [0300]: NVIDIA Corporation Example GPU [10de:1234] (rev a1)\n02:00.0 Audio device [0403]: Vendor Audio [1234:5678]\n",
        );

        assert_eq!(adapters.len(), 1);
        assert!(adapters[0].contains("NVIDIA Corporation Example GPU"));
        assert_eq!(format_memory(64 * 1024 * 1024 * 1024), "64.0 GiB");
    }
}
