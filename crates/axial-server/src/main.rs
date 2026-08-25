use std::env;
use std::net::SocketAddr;
use std::path::PathBuf;

use anyhow::{Context, Result};
use axial_server::WebProject;
use tracing_subscriber::EnvFilter;

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "axial_server=info,tower_http=info".into()),
        )
        .init();

    let root = env::var_os("AXIAL_PROJECT_ROOT")
        .map(PathBuf::from)
        .unwrap_or(env::current_dir().context("current directory")?);
    let graph = match env::var_os("AXIAL_GRAPH") {
        Some(path) => PathBuf::from(path),
        None => {
            let path = root.join(".axial/web.axial.json");
            if !path.exists() {
                let parent = path.parent().context("web graph parent")?;
                std::fs::create_dir_all(parent).context("create .axial directory")?;
                std::fs::copy(root.join("testdata/fastq_to_fastqc.axial.json"), &path)
                    .context("initialize web graph")?;
            }
            path
        }
    };
    let address: SocketAddr = env::var("AXIAL_WEB_ADDR")
        .unwrap_or_else(|_| "127.0.0.1:7310".to_owned())
        .parse()
        .context("AXIAL_WEB_ADDR")?;
    let project = WebProject::open(&root, graph).context("open Axial web project")?;
    let listener = tokio::net::TcpListener::bind(address).await?;
    tracing::info!(%address, "Axial web server listening");
    axum::serve(listener, axial_server::app(project)).await?;
    Ok(())
}
