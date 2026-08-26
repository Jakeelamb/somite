use std::cmp::Ordering;
use std::collections::BTreeMap;
use std::ffi::OsStr;
use std::path::Path;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tokio::process::Command;

pub const ACP_REGISTRY_URL: &str =
    "https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json";
const MAX_REGISTRY_BYTES: usize = 1024 * 1024;

const FALLBACK_REGISTRY: &str = r#"
{
  "version": "1.0.0",
  "agents": [
    {
      "id": "codex-acp",
      "name": "Codex",
      "version": "1.6.2",
      "description": "ACP adapter for OpenAI's coding assistant",
      "repository": "https://github.com/agentclientprotocol/codex-acp",
      "distribution": {
        "npx": { "package": "@agentclientprotocol/codex-acp@1.6.2" }
      }
    },
    {
      "id": "opencode",
      "name": "OpenCode",
      "version": "1.18.23",
      "description": "The open source coding agent",
      "repository": "https://github.com/anomalyco/opencode",
      "website": "https://opencode.ai",
      "distribution": {
        "binary": {
          "linux-x86_64": { "archive": "", "cmd": "./opencode", "args": ["acp"] },
          "linux-aarch64": { "archive": "", "cmd": "./opencode", "args": ["acp"] },
          "darwin-x86_64": { "archive": "", "cmd": "./opencode", "args": ["acp"] },
          "darwin-aarch64": { "archive": "", "cmd": "./opencode", "args": ["acp"] }
        }
      }
    },
    {
      "id": "claude-acp",
      "name": "Claude Agent",
      "version": "0.70.0",
      "description": "ACP wrapper for Anthropic's Claude",
      "repository": "https://github.com/agentclientprotocol/claude-agent-acp",
      "distribution": {
        "npx": { "package": "@agentclientprotocol/claude-agent-acp@0.70.0" }
      }
    },
    {
      "id": "github-copilot-cli",
      "name": "GitHub Copilot",
      "version": "1.0.80",
      "description": "GitHub's AI pair programmer",
      "repository": "https://github.com/github/copilot-cli",
      "website": "https://github.com/features/copilot/cli/",
      "distribution": {
        "npx": { "package": "@github/copilot@1.0.80", "args": ["--acp"] }
      }
    }
  ]
}
"#;

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AgentAvailability {
    Installed,
    Ready,
    Unavailable,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct DiscoveredAgent {
    pub id: String,
    pub name: String,
    pub version: String,
    pub description: String,
    pub command: Option<String>,
    pub availability: AgentAvailability,
    pub availability_detail: String,
    pub repository: Option<String>,
    pub website: Option<String>,
    pub icon: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct AgentDiscoveryResponse {
    pub registry_url: &'static str,
    pub registry_status: &'static str,
    pub agents: Vec<DiscoveredAgent>,
}

#[derive(Debug, Deserialize)]
struct RegistryIndex {
    agents: Vec<RegistryAgent>,
}

#[derive(Debug, Deserialize)]
struct RegistryAgent {
    id: String,
    name: String,
    version: String,
    description: String,
    #[serde(default)]
    repository: Option<String>,
    #[serde(default)]
    website: Option<String>,
    #[serde(default)]
    icon: Option<String>,
    distribution: RegistryDistribution,
}

#[derive(Debug, Deserialize)]
struct RegistryDistribution {
    #[serde(default)]
    binary: Option<BTreeMap<String, BinaryDistribution>>,
    #[serde(default)]
    npx: Option<PackageDistribution>,
    #[serde(default)]
    uvx: Option<PackageDistribution>,
}

#[derive(Debug, Deserialize)]
struct BinaryDistribution {
    cmd: String,
    #[serde(default)]
    args: Vec<String>,
}

#[derive(Debug, Deserialize)]
struct PackageDistribution {
    package: String,
    #[serde(default)]
    args: Vec<String>,
}

pub async fn discover_agents() -> AgentDiscoveryResponse {
    let live_registry = fetch_registry().await;
    let (registry, registry_status) = live_registry
        .as_deref()
        .and_then(parse_registry)
        .map(|registry| (registry, "live"))
        .or_else(|| parse_registry(FALLBACK_REGISTRY).map(|registry| (registry, "offline_cache")))
        .unwrap_or_else(|| (RegistryIndex { agents: Vec::new() }, "unavailable"));

    let platform = current_platform();
    let agents = resolve_registry(registry, platform, &command_available);
    AgentDiscoveryResponse {
        registry_url: ACP_REGISTRY_URL,
        registry_status,
        agents,
    }
}

async fn fetch_registry() -> Option<String> {
    let output = tokio::time::timeout(
        Duration::from_secs(4),
        Command::new("curl")
            .args([
                "--fail",
                "--silent",
                "--show-error",
                "--location",
                "--max-time",
                "3",
                ACP_REGISTRY_URL,
            ])
            .output(),
    )
    .await
    .ok()?
    .ok()?;
    if !output.status.success() || output.stdout.len() > MAX_REGISTRY_BYTES {
        return None;
    }
    String::from_utf8(output.stdout).ok()
}

fn parse_registry(json: &str) -> Option<RegistryIndex> {
    serde_json::from_str(json).ok()
}

fn resolve_registry(
    registry: RegistryIndex,
    platform: &str,
    available: &dyn Fn(&str) -> bool,
) -> Vec<DiscoveredAgent> {
    let mut agents = registry
        .agents
        .into_iter()
        .filter_map(|agent| resolve_agent(agent, platform, available))
        .collect::<Vec<_>>();
    agents.sort_by(compare_agents);
    agents
}

fn resolve_agent(
    agent: RegistryAgent,
    platform: &str,
    available: &dyn Fn(&str) -> bool,
) -> Option<DiscoveredAgent> {
    let companion = companion_command(&agent.id);
    let companion_installed = companion.is_some_and(available);

    let (command, availability, availability_detail) = if let Some(binary) = agent
        .distribution
        .binary
        .as_ref()
        .and_then(|targets| targets.get(platform))
    {
        let executable = executable_name(&binary.cmd)?;
        let launch = join_command(&executable, &binary.args)?;
        if available(&executable) {
            (
                Some(launch),
                AgentAvailability::Installed,
                format!("{executable} detected on this computer"),
            )
        } else {
            (
                None,
                AgentAvailability::Unavailable,
                format!("Install {name} to connect", name = agent.name),
            )
        }
    } else if let Some(package) = agent.distribution.npx.as_ref() {
        let launch = package_command("npx", &["-y"], package)?;
        if available("npx") {
            let (availability, detail) = if companion_installed {
                (
                    AgentAvailability::Installed,
                    format!(
                        "{} detected on this computer",
                        companion.unwrap_or_default()
                    ),
                )
            } else {
                (
                    AgentAvailability::Ready,
                    "Verified ACP Registry package · downloads on first launch".to_owned(),
                )
            };
            (Some(launch), availability, detail)
        } else {
            (
                None,
                AgentAvailability::Unavailable,
                "Node.js npx is not available".to_owned(),
            )
        }
    } else if let Some(package) = agent.distribution.uvx.as_ref() {
        let launch = package_command("uvx", &[], package)?;
        if available("uvx") {
            (
                Some(launch),
                AgentAvailability::Ready,
                "Verified ACP Registry package · downloads on first launch".to_owned(),
            )
        } else {
            (
                None,
                AgentAvailability::Unavailable,
                "uvx is not available".to_owned(),
            )
        }
    } else {
        return None;
    };

    Some(DiscoveredAgent {
        id: agent.id,
        name: agent.name,
        version: agent.version,
        description: agent.description,
        command,
        availability,
        availability_detail,
        repository: agent.repository,
        website: agent.website,
        icon: agent.icon,
    })
}

fn companion_command(agent_id: &str) -> Option<&'static str> {
    match agent_id {
        "codex-acp" => Some("codex"),
        "claude-acp" => Some("claude"),
        "github-copilot-cli" => Some("copilot"),
        _ => None,
    }
}

fn executable_name(command: &str) -> Option<String> {
    let name = Path::new(command).file_name()?.to_str()?;
    let name = name.strip_suffix(".exe").unwrap_or(name);
    safe_token(name).then(|| name.to_owned())
}

fn package_command(
    runner: &str,
    runner_args: &[&str],
    package: &PackageDistribution,
) -> Option<String> {
    if !safe_token(&package.package) || package.args.iter().any(|arg| !safe_token(arg)) {
        return None;
    }
    let mut parts = vec![runner.to_owned()];
    parts.extend(runner_args.iter().map(|arg| (*arg).to_owned()));
    parts.push(package.package.clone());
    parts.extend(package.args.clone());
    Some(parts.join(" "))
}

fn join_command(executable: &str, args: &[String]) -> Option<String> {
    if !safe_token(executable) || args.iter().any(|arg| !safe_token(arg)) {
        return None;
    }
    Some(
        std::iter::once(executable.to_owned())
            .chain(args.iter().cloned())
            .collect::<Vec<_>>()
            .join(" "),
    )
}

fn safe_token(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 512
        && value.bytes().all(|byte| {
            byte.is_ascii_alphanumeric()
                || matches!(byte, b'_' | b'-' | b'.' | b'/' | b'@' | b':' | b'=' | b'+')
        })
}

fn compare_agents(left: &DiscoveredAgent, right: &DiscoveredAgent) -> Ordering {
    availability_rank(left.availability)
        .cmp(&availability_rank(right.availability))
        .then_with(|| preferred_rank(&left.id).cmp(&preferred_rank(&right.id)))
        .then_with(|| left.name.to_lowercase().cmp(&right.name.to_lowercase()))
}

fn availability_rank(availability: AgentAvailability) -> u8 {
    match availability {
        AgentAvailability::Installed => 0,
        AgentAvailability::Ready => 1,
        AgentAvailability::Unavailable => 2,
    }
}

fn preferred_rank(id: &str) -> u8 {
    match id {
        "codex-acp" => 0,
        "opencode" => 1,
        "claude-acp" => 2,
        "github-copilot-cli" => 3,
        _ => 4,
    }
}

fn current_platform() -> &'static str {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("linux", "x86_64") => "linux-x86_64",
        ("linux", "aarch64") => "linux-aarch64",
        ("macos", "x86_64") => "darwin-x86_64",
        ("macos", "aarch64") => "darwin-aarch64",
        ("windows", "x86_64") => "windows-x86_64",
        ("windows", "aarch64") => "windows-aarch64",
        _ => "unsupported",
    }
}

fn command_available(command: &str) -> bool {
    let Some(path) = std::env::var_os("PATH") else {
        return false;
    };
    command_available_in_path(command, &path)
}

fn command_available_in_path(command: &str, path: &OsStr) -> bool {
    std::env::split_paths(path).any(|directory| executable_file(&directory.join(command)))
}

fn executable_file(path: &Path) -> bool {
    let Ok(metadata) = path.metadata() else {
        return false;
    };
    if !metadata.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        metadata.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    {
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = r#"
    {
      "agents": [
        {
          "id": "opencode",
          "name": "OpenCode",
          "version": "1.2.3",
          "description": "Native ACP",
          "distribution": {
            "binary": {
              "linux-x86_64": { "cmd": "./opencode", "args": ["acp"] }
            }
          }
        },
        {
          "id": "codex-acp",
          "name": "Codex",
          "version": "2.3.4",
          "description": "Codex adapter",
          "distribution": {
            "npx": { "package": "@agentclientprotocol/codex-acp@2.3.4" }
          }
        },
        {
          "id": "bad",
          "name": "Unsafe",
          "version": "1.0.0",
          "description": "Unsafe package",
          "distribution": {
            "npx": { "package": "pkg;touch", "args": ["/tmp/no"] }
          }
        }
      ]
    }
    "#;

    #[test]
    fn installed_agents_sort_first_and_commands_are_registry_pinned() {
        let registry = parse_registry(SAMPLE).expect("sample registry");
        let available = |command: &str| matches!(command, "codex" | "npx");
        let agents = resolve_registry(registry, "linux-x86_64", &available);

        assert_eq!(agents.len(), 2);
        assert_eq!(agents[0].id, "codex-acp");
        assert_eq!(agents[0].availability, AgentAvailability::Installed);
        assert_eq!(
            agents[0].command.as_deref(),
            Some("npx -y @agentclientprotocol/codex-acp@2.3.4")
        );
        assert_eq!(agents[1].availability, AgentAvailability::Unavailable);
    }

    #[test]
    fn native_registry_binary_uses_the_installed_path_command() {
        let registry = parse_registry(SAMPLE).expect("sample registry");
        let available = |command: &str| matches!(command, "opencode" | "npx");
        let agents = resolve_registry(registry, "linux-x86_64", &available);
        let opencode = agents
            .iter()
            .find(|agent| agent.id == "opencode")
            .expect("opencode candidate");

        assert_eq!(opencode.availability, AgentAvailability::Installed);
        assert_eq!(opencode.command.as_deref(), Some("opencode acp"));
    }
}
