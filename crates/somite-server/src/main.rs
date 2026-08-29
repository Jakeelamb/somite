use std::env;
use std::io::Write;
use std::net::SocketAddr;
use std::path::PathBuf;

use anyhow::{Context, Result};
use somite_server::WebProject;
use tracing_subscriber::EnvFilter;

#[tokio::main]
async fn main() -> Result<()> {
    let mut arguments = env::args().skip(1);
    if arguments.next().as_deref() == Some("mcp") {
        let flag = arguments.next().context("mcp requires --server-url")?;
        anyhow::ensure!(flag == "--server-url", "mcp requires --server-url");
        let server_url = arguments
            .next()
            .context("mcp requires a local server URL")?;
        anyhow::ensure!(arguments.next().is_none(), "unexpected mcp arguments");
        let runtime_capability = env::var("SOMITE_MCP_RUNTIME_CAPABILITY")
            .context("mcp requires SOMITE_MCP_RUNTIME_CAPABILITY")?;
        return somite_server::serve_mcp_stdio(server_url, runtime_capability).await;
    }

    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "somite_server=info,tower_http=info".into()),
        )
        .init();

    let root = env::var_os("SOMITE_PROJECT_ROOT")
        .map(PathBuf::from)
        .unwrap_or(env::current_dir().context("current directory")?);
    let root = root.canonicalize().context("canonical project root")?;
    let graph = match env::var_os("SOMITE_GRAPH") {
        Some(path) => PathBuf::from(path),
        None => {
            let path = root.join(".somite/web.somite.json");
            initialize_default_graph(&root, &path)?;
            path
        }
    };
    let address: SocketAddr = env::var("SOMITE_WEB_ADDR")
        .unwrap_or_else(|_| "127.0.0.1:7310".to_owned())
        .parse()
        .context("SOMITE_WEB_ADDR")?;
    let project = WebProject::open(&root, graph).context("open Somite web project")?;
    let listener = tokio::net::TcpListener::bind(address).await?;
    tracing::info!(%address, "Somite web server listening");
    axum::serve(listener, somite_server::app(project)).await?;
    Ok(())
}

fn initialize_default_graph(root: &std::path::Path, path: &std::path::Path) -> Result<()> {
    match std::fs::symlink_metadata(path) {
        Ok(metadata) => {
            anyhow::ensure!(
                metadata.is_file() && !metadata.file_type().is_symlink(),
                "default web graph must be a regular non-symlink file"
            );
            return Ok(());
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error).context("inspect default web graph"),
    }

    let parent = path.parent().context("web graph parent")?;
    match std::fs::create_dir(parent) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
        Err(error) => return Err(error).context("create .somite directory"),
    }
    let parent_metadata = std::fs::symlink_metadata(parent).context("inspect .somite directory")?;
    anyhow::ensure!(
        parent_metadata.is_dir() && !parent_metadata.file_type().is_symlink(),
        ".somite must be a regular non-symlink directory"
    );
    let canonical_parent = parent
        .canonicalize()
        .context("canonical .somite directory")?;
    anyhow::ensure!(
        canonical_parent.parent() == Some(root),
        ".somite escapes the canonical project root"
    );

    let source = std::fs::read(root.join("testdata/fastq_to_fastqc.somite.json"))
        .context("read initial web graph")?;
    let mut temporary = tempfile::Builder::new()
        .prefix(".somite-initial-graph-")
        .tempfile_in(&canonical_parent)
        .context("create initial graph temporary file")?;
    temporary
        .as_file_mut()
        .write_all(&source)
        .context("write initial web graph")?;
    temporary
        .as_file_mut()
        .flush()
        .context("flush initial web graph")?;
    temporary
        .as_file()
        .sync_all()
        .context("sync initial web graph")?;
    temporary
        .persist_noclobber(path)
        .map_err(|error| error.error)
        .context("publish initial web graph")?;
    #[cfg(unix)]
    std::fs::File::open(&canonical_parent)
        .and_then(|directory| directory.sync_all())
        .context("sync .somite directory")?;
    Ok(())
}
