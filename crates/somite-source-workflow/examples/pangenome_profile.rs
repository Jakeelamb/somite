use std::env;
use std::error::Error;
use std::hint::black_box;
use std::io;
use std::path::PathBuf;

use somite_ir::{SourceProvider, WorkflowBinding};
use somite_source_workflow::{
    apply, freeze_local, load_local, EditTransaction, LoadLocalRequest, SemanticEdit,
};

const INPUT_BINDING: &str = "inputs/reference.fasta.gz";

fn main() -> Result<(), Box<dyn Error>> {
    let source_root = required_env("SOMITE_PANGENOME_SOURCE")?;
    let commit = required_env("SOMITE_PANGENOME_COMMIT")?;
    let iterations = env::var("SOMITE_PERF_ITERATIONS")
        .ok()
        .map_or(Ok(1), |value| value.parse::<usize>())?;
    if iterations == 0 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "SOMITE_PERF_ITERATIONS must be greater than zero",
        )
        .into());
    }

    let request = LoadLocalRequest {
        root: PathBuf::from(source_root),
        provider: SourceProvider::NfCore,
        repository: "nf-core/pangenome".to_owned(),
        requested_revision: "1.1.3".to_owned(),
        expected_resolved_revision: commit.clone(),
        entrypoint: "main.nf".to_owned(),
        profiles: Vec::new(),
    };

    let mut last_freeze_digest = String::new();
    for _ in 0..iterations {
        let loaded = load_local(&request)?;
        assert_eq!(loaded.workflow.source.resolved_revision, commit);
        assert!(!loaded.workflow.capabilities.exact_execution);

        let edited = apply(
            &loaded.workflow,
            &EditTransaction {
                base_workflow_revision: loaded.workflow.workflow_revision.clone(),
                edits: vec![SemanticEdit::SetParameter {
                    name: "input".to_owned(),
                    binding: WorkflowBinding::ProjectFile {
                        path: INPUT_BINDING.to_owned(),
                    },
                }],
            },
        )?;
        let frozen = freeze_local(&request.root, &edited)?;
        assert_eq!(frozen.manifest.workflow_revision, edited.workflow_revision);
        assert_eq!(frozen.manifest.source, loaded.source_manifest);
        assert_eq!(
            frozen.source_files.len(),
            usize::try_from(edited.source.file_count)?
        );
        assert_eq!(
            frozen.params_json,
            b"{\n  \"input\": \"inputs/reference.fasta.gz\"\n}\n"
        );

        last_freeze_digest.clone_from(&frozen.manifest.freeze_digest);
        black_box((&loaded, &edited, &frozen));
    }

    println!("iterations={iterations} freeze_digest={last_freeze_digest}");
    Ok(())
}

fn required_env(name: &'static str) -> Result<String, io::Error> {
    env::var(name).map_err(|_| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("{name} must contain the exact pinned source value"),
        )
    })
}
