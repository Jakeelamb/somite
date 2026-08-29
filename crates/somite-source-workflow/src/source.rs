use std::borrow::Cow;
use std::collections::{BTreeMap, BTreeSet};
use std::env;
use std::fs;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::Path;
use std::process::{Command, Stdio};

use sha1::{Digest, Sha1};
use sha2::Sha256;

use crate::model::{
    canonical_git_object_id, digest, safe_relative_path, LoadLocalRequest, SourceFileManifest,
    SourceManifest, SourceWorkflowError,
};
use crate::FrozenSourceFile;

const MAX_TRACKED_FILES: usize = 20_000;
const MAX_TRACKED_FILE_BYTES: u64 = 64 * 1024 * 1024;
const MAX_SOURCE_BYTES: u64 = 512 * 1024 * 1024;
const MAX_GIT_METADATA_BYTES: usize = 64 * 1024 * 1024;
const MAX_GIT_DIAGNOSTIC_BYTES: usize = 64 * 1024;

struct BoundedCapture {
    bytes: Vec<u8>,
    exceeded: bool,
}

fn drain_bounded<R: Read>(mut reader: R, limit: usize) -> std::io::Result<BoundedCapture> {
    let mut bytes = Vec::with_capacity(limit.min(8 * 1024));
    let mut exceeded = false;
    let mut chunk = [0_u8; 8 * 1024];
    loop {
        let read = reader.read(&mut chunk)?;
        if read == 0 {
            break;
        }
        let retained = limit.saturating_sub(bytes.len()).min(read);
        bytes.extend_from_slice(&chunk[..retained]);
        exceeded |= retained < read;
    }
    Ok(BoundedCapture { bytes, exceeded })
}

fn join_capture(
    reader: std::thread::JoinHandle<std::io::Result<BoundedCapture>>,
    operation: &'static str,
    stream: &str,
) -> Result<BoundedCapture, SourceWorkflowError> {
    match reader.join() {
        Ok(Ok(capture)) => Ok(capture),
        Ok(Err(error)) => Err(SourceWorkflowError::GitFailed {
            operation,
            detail: format!("could not read Git {stream}: {error}"),
        }),
        Err(_) => Err(SourceWorkflowError::GitFailed {
            operation,
            detail: format!("Git {stream} reader panicked"),
        }),
    }
}

fn diagnostic_detail(capture: &BoundedCapture) -> String {
    let mut detail = String::from_utf8_lossy(&capture.bytes).trim().to_owned();
    if capture.exceeded {
        detail.push_str(" [diagnostic truncated]");
    }
    detail
}

pub(crate) struct TrackedSourceFile<'source> {
    pub manifest: SourceFileManifest,
    pub bytes: Cow<'source, [u8]>,
}

pub(crate) struct ReadSource {
    pub resolved_revision: String,
    pub manifest: SourceManifest,
    pub files: Vec<TrackedSourceFile<'static>>,
}

pub(crate) fn verify_frozen_source<'source>(
    manifest: &SourceManifest,
    source_files: &'source [FrozenSourceFile],
    entrypoint: &str,
) -> Result<Vec<TrackedSourceFile<'source>>, SourceWorkflowError> {
    if manifest.schema_version != 1 {
        return Err(SourceWorkflowError::InvalidWorkflow(format!(
            "source manifest schema_version {} != 1",
            manifest.schema_version
        )));
    }
    if !safe_relative_path(entrypoint) {
        return Err(SourceWorkflowError::InvalidRequest {
            field: "entrypoint",
            detail: "must be a safe relative path".to_owned(),
        });
    }
    validate_file_count(manifest.files.len())?;
    if manifest.files.is_empty() || source_files.len() != manifest.files.len() {
        return Err(SourceWorkflowError::SourceChanged {
            expected: format!("{} manifest files", manifest.files.len()),
            actual: format!("{} frozen files", source_files.len()),
        });
    }

    let mut frozen_by_path = BTreeMap::new();
    for file in source_files {
        if !safe_relative_path(&file.path) {
            return Err(SourceWorkflowError::UnsafePath(file.path.clone()));
        }
        if frozen_by_path.insert(file.path.as_str(), file).is_some() {
            return Err(SourceWorkflowError::SourceChanged {
                expected: "one frozen file per manifest path".to_owned(),
                actual: format!("duplicate frozen path {}", file.path),
            });
        }
    }

    let mut tracked = Vec::with_capacity(manifest.files.len());
    let mut manifest_paths = BTreeSet::new();
    let mut previous_path: Option<&str> = None;
    let mut source_bytes = 0_u64;
    let mut entrypoint_found = false;
    for identity in &manifest.files {
        if !safe_relative_path(&identity.path) {
            return Err(SourceWorkflowError::UnsafePath(identity.path.clone()));
        }
        if previous_path.is_some_and(|previous| previous >= identity.path.as_str())
            || !manifest_paths.insert(identity.path.as_str())
        {
            return Err(SourceWorkflowError::SourceChanged {
                expected: "unique manifest paths in lexical order".to_owned(),
                actual: identity.path.clone(),
            });
        }
        previous_path = Some(identity.path.as_str());
        if !matches!(identity.mode, 0o100644 | 0o100755) {
            return Err(SourceWorkflowError::UnsupportedTrackedEntry {
                path: identity.path.clone(),
                kind: "file mode",
            });
        }
        if identity.bytes > MAX_TRACKED_FILE_BYTES {
            return Err(SourceWorkflowError::SourceTooLarge(format!(
                "tracked file {} is {} bytes; limit is {MAX_TRACKED_FILE_BYTES}",
                identity.path, identity.bytes
            )));
        }
        let file = frozen_by_path
            .get(identity.path.as_str())
            .ok_or_else(|| SourceWorkflowError::MissingTrackedEntry(identity.path.clone()))?;
        if file.mode != identity.mode {
            return Err(SourceWorkflowError::SourceChanged {
                expected: format!("mode {:o} for {}", identity.mode, identity.path),
                actual: format!("mode {:o}", file.mode),
            });
        }
        let byte_count = u64::try_from(file.bytes.len()).map_err(|_| {
            SourceWorkflowError::SourceTooLarge(format!("{} exceeds u64", identity.path))
        })?;
        let file_digest = digest(&file.bytes);
        if byte_count != identity.bytes || file_digest != identity.digest {
            return Err(SourceWorkflowError::SourceChanged {
                expected: format!(
                    "{} bytes / {} for {}",
                    identity.bytes, identity.digest, identity.path
                ),
                actual: format!("{byte_count} bytes / {file_digest}"),
            });
        }
        source_bytes = source_bytes.checked_add(byte_count).ok_or_else(|| {
            SourceWorkflowError::SourceTooLarge("tracked byte count overflowed u64".to_owned())
        })?;
        if source_bytes > MAX_SOURCE_BYTES {
            return Err(SourceWorkflowError::SourceTooLarge(format!(
                "tracked source exceeds total byte limit {MAX_SOURCE_BYTES}"
            )));
        }
        entrypoint_found |= identity.path == entrypoint;
        tracked.push(TrackedSourceFile {
            manifest: identity.clone(),
            bytes: Cow::Borrowed(&file.bytes),
        });
    }
    if !entrypoint_found {
        return Err(SourceWorkflowError::MissingEntrypoint(
            entrypoint.to_owned(),
        ));
    }
    if source_bytes != manifest.source_bytes {
        return Err(SourceWorkflowError::SourceChanged {
            expected: format!("{} source bytes", manifest.source_bytes),
            actual: format!("{source_bytes} source bytes"),
        });
    }
    let actual_digest = source_digest(&tracked);
    if actual_digest != manifest.source_digest {
        return Err(SourceWorkflowError::SourceChanged {
            expected: manifest.source_digest.clone(),
            actual: actual_digest,
        });
    }
    Ok(tracked)
}

pub(crate) fn read_pinned_source(
    request: &LoadLocalRequest,
) -> Result<ReadSource, SourceWorkflowError> {
    let requested_root =
        fs::canonicalize(&request.root).map_err(|source| SourceWorkflowError::Read {
            path: request.root.display().to_string(),
            source,
        })?;
    let reported_root = git_text(&requested_root, &["rev-parse", "--show-toplevel"], "root")?;
    let reported_root =
        fs::canonicalize(reported_root.trim()).map_err(|source| SourceWorkflowError::Read {
            path: reported_root.trim().to_owned(),
            source,
        })?;
    if requested_root != reported_root {
        return Err(SourceWorkflowError::NotWorktreeRoot(
            request.root.display().to_string(),
        ));
    }

    let resolved_revision = git_text(
        &requested_root,
        &["rev-parse", "--verify", "HEAD^{commit}"],
        "revision",
    )?
    .trim()
    .to_owned();
    if !canonical_git_object_id(&resolved_revision) {
        return Err(git_failed(
            "revision",
            "Git returned a non-canonical commit object ID",
        ));
    }
    if resolved_revision != request.expected_resolved_revision {
        return Err(SourceWorkflowError::RevisionMismatch {
            expected: request.expected_resolved_revision.clone(),
            actual: resolved_revision,
        });
    }
    let requested_commit_spec = format!("{}^{{commit}}", request.requested_revision);
    let requested_commit = git_text(
        &requested_root,
        &[
            "rev-parse",
            "--verify",
            "--end-of-options",
            &requested_commit_spec,
        ],
        "requested revision",
    )?
    .trim()
    .to_owned();
    if !canonical_git_object_id(&requested_commit) {
        return Err(git_failed(
            "requested revision",
            "Git returned a non-canonical commit object ID",
        ));
    }
    if requested_commit != resolved_revision {
        return Err(SourceWorkflowError::RequestedRevisionMismatch {
            requested: request.requested_revision.clone(),
            expected: resolved_revision,
            actual: requested_commit,
        });
    }

    let tree = git_bytes(
        &requested_root,
        &[
            "ls-tree",
            "-r",
            "-z",
            "-l",
            "--full-tree",
            &resolved_revision,
        ],
        "commit-tree listing",
    )?;
    let entries = parse_tree(&tree)?;
    if entries.is_empty() {
        return Err(SourceWorkflowError::SourceTooLarge(
            "source has no tracked files".to_owned(),
        ));
    }
    let blobs = read_commit_blobs(&requested_root, &entries)?;
    let mut files = Vec::with_capacity(entries.len());
    let mut entrypoint_found = false;
    for (entry, bytes) in entries.into_iter().zip(blobs) {
        if entry.path == request.entrypoint {
            entrypoint_found = true;
        }
        let byte_count = u64::try_from(bytes.len()).map_err(|_| {
            SourceWorkflowError::SourceTooLarge(format!("{} exceeds u64", entry.path))
        })?;
        if byte_count != entry.bytes {
            return Err(SourceWorkflowError::SourceChanged {
                expected: format!("{} bytes for {}", entry.bytes, entry.path),
                actual: format!("{byte_count} bytes"),
            });
        }
        files.push(TrackedSourceFile {
            manifest: SourceFileManifest {
                path: entry.path,
                mode: entry.mode,
                bytes: byte_count,
                digest: digest(&bytes),
            },
            bytes: Cow::Owned(bytes),
        });
    }
    if !entrypoint_found {
        return Err(SourceWorkflowError::MissingEntrypoint(
            request.entrypoint.clone(),
        ));
    }
    let source_bytes = files.iter().map(|file| file.manifest.bytes).sum();
    let source_digest = source_digest(&files);
    let manifest = SourceManifest {
        schema_version: 1,
        source_digest,
        source_bytes,
        files: files.iter().map(|file| file.manifest.clone()).collect(),
    };
    Ok(ReadSource {
        resolved_revision,
        manifest,
        files,
    })
}

fn validate_file_count(count: usize) -> Result<(), SourceWorkflowError> {
    if count > MAX_TRACKED_FILES {
        Err(SourceWorkflowError::SourceTooLarge(format!(
            "tracked file count {count} exceeds limit {MAX_TRACKED_FILES}"
        )))
    } else {
        Ok(())
    }
}

struct TreeEntry {
    path: String,
    mode: u32,
    object: String,
    bytes: u64,
}

fn parse_tree(tree: &[u8]) -> Result<Vec<TreeEntry>, SourceWorkflowError> {
    let mut entries = Vec::new();
    let mut source_bytes = 0_u64;
    for record in tree
        .split(|byte| *byte == 0)
        .filter(|record| !record.is_empty())
    {
        validate_file_count(entries.len().saturating_add(1))?;
        let tab = record
            .iter()
            .position(|byte| *byte == b'\t')
            .ok_or_else(|| git_failed("commit-tree listing", "malformed tree record"))?;
        let metadata = std::str::from_utf8(&record[..tab])
            .map_err(|_| git_failed("commit-tree listing", "non-UTF-8 tree metadata"))?;
        let mut fields = metadata.split_ascii_whitespace();
        let mode_text = fields
            .next()
            .ok_or_else(|| git_failed("commit-tree listing", "missing mode"))?;
        let kind = fields
            .next()
            .ok_or_else(|| git_failed("commit-tree listing", "missing object type"))?;
        let object = fields
            .next()
            .ok_or_else(|| git_failed("commit-tree listing", "missing object id"))?;
        let size = fields
            .next()
            .ok_or_else(|| git_failed("commit-tree listing", "missing object size"))?;
        if fields.next().is_some()
            || !matches!(object.len(), 40 | 64)
            || !object.bytes().all(|byte| byte.is_ascii_hexdigit())
        {
            return Err(git_failed("commit-tree listing", "malformed tree metadata"));
        }
        let path = std::str::from_utf8(&record[tab + 1..])
            .map_err(|_| SourceWorkflowError::NonUtf8Path)?
            .to_owned();
        if !safe_relative_path(&path) {
            return Err(SourceWorkflowError::UnsafePath(path));
        }
        let mode = u32::from_str_radix(mode_text, 8)
            .map_err(|_| git_failed("commit-tree listing", format!("invalid mode {mode_text}")))?;
        match mode_text {
            "100644" | "100755" if kind == "blob" => {}
            "120000" => {
                return Err(SourceWorkflowError::UnsupportedTrackedEntry {
                    path,
                    kind: "symlink",
                });
            }
            "160000" => {
                return Err(SourceWorkflowError::UnsupportedTrackedEntry {
                    path,
                    kind: "submodule",
                });
            }
            _ => {
                return Err(SourceWorkflowError::UnsupportedTrackedEntry {
                    path,
                    kind: "non-blob file mode",
                });
            }
        }
        let bytes = size
            .parse::<u64>()
            .map_err(|_| git_failed("commit-tree listing", format!("invalid blob size {size}")))?;
        if bytes > MAX_TRACKED_FILE_BYTES {
            return Err(SourceWorkflowError::SourceTooLarge(format!(
                "tracked file {path} is {bytes} bytes; limit is {MAX_TRACKED_FILE_BYTES}"
            )));
        }
        source_bytes = source_bytes.checked_add(bytes).ok_or_else(|| {
            SourceWorkflowError::SourceTooLarge("tracked byte count overflowed u64".to_owned())
        })?;
        if source_bytes > MAX_SOURCE_BYTES {
            return Err(SourceWorkflowError::SourceTooLarge(format!(
                "tracked source exceeds total byte limit {MAX_SOURCE_BYTES}"
            )));
        }
        entries.push(TreeEntry {
            path,
            mode,
            object: object.to_owned(),
            bytes,
        });
    }
    entries.sort_by(|left, right| left.path.cmp(&right.path));
    if entries.windows(2).any(|pair| pair[0].path == pair[1].path) {
        return Err(git_failed("commit-tree listing", "duplicate tree paths"));
    }
    Ok(entries)
}

fn read_commit_blobs(
    root: &Path,
    entries: &[TreeEntry],
) -> Result<Vec<Vec<u8>>, SourceWorkflowError> {
    let mut command = Command::new("git");
    isolate_git(&mut command);
    let mut child = command
        .arg("-C")
        .arg(root)
        .args(["cat-file", "--batch"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(SourceWorkflowError::GitUnavailable)?;
    let mut stdin = child
        .stdin
        .take()
        .ok_or_else(|| git_failed("commit blob read", "missing batch stdin"))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| git_failed("commit blob read", "missing batch stdout"))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| git_failed("commit blob read", "missing batch stderr"))?;
    let stderr_reader = std::thread::spawn(move || drain_bounded(stderr, MAX_GIT_DIAGNOSTIC_BYTES));
    let mut stdout = BufReader::new(stdout);
    let parsed = (|| {
        let mut blobs = Vec::with_capacity(entries.len());
        for entry in entries {
            writeln!(stdin, "{}", entry.object)
                .and_then(|_| stdin.flush())
                .map_err(|error| git_failed("commit blob read", error.to_string()))?;
            let mut header = Vec::new();
            let read = (&mut stdout)
                .take(513)
                .read_until(b'\n', &mut header)
                .map_err(|error| git_failed("commit blob read", error.to_string()))?;
            if read == 0 || read > 512 || header.last() != Some(&b'\n') {
                return Err(git_failed("commit blob read", "malformed batch header"));
            }
            header.pop();
            let header = std::str::from_utf8(&header)
                .map_err(|_| git_failed("commit blob read", "non-UTF-8 batch header"))?;
            let mut fields = header.split_ascii_whitespace();
            let object = fields.next();
            let kind = fields.next();
            let bytes = fields.next().and_then(|value| value.parse::<u64>().ok());
            if object != Some(entry.object.as_str())
                || kind != Some("blob")
                || bytes != Some(entry.bytes)
                || fields.next().is_some()
            {
                return Err(git_failed(
                    "commit blob read",
                    format!("unexpected batch header for {}", entry.path),
                ));
            }
            let capacity = usize::try_from(entry.bytes).map_err(|_| {
                SourceWorkflowError::SourceTooLarge(format!("{} exceeds usize", entry.path))
            })?;
            let mut blob = vec![0; capacity];
            stdout
                .read_exact(&mut blob)
                .map_err(|error| git_failed("commit blob read", error.to_string()))?;
            let mut delimiter = [0_u8; 1];
            stdout
                .read_exact(&mut delimiter)
                .map_err(|error| git_failed("commit blob read", error.to_string()))?;
            if delimiter != [b'\n'] {
                return Err(git_failed(
                    "commit blob read",
                    "missing batch object delimiter",
                ));
            }
            let actual = git_blob_object_id(&blob, entry.object.len())?;
            if actual != entry.object {
                return Err(SourceWorkflowError::SourceChanged {
                    expected: format!("Git blob {} for {}", entry.object, entry.path),
                    actual: format!("Git blob {actual}"),
                });
            }
            blobs.push(blob);
        }
        drop(stdin);
        let mut trailing = [0_u8; 1];
        if stdout
            .read(&mut trailing)
            .map_err(|error| git_failed("commit blob read", error.to_string()))?
            != 0
        {
            return Err(git_failed("commit blob read", "unrequested batch output"));
        }
        Ok(blobs)
    })();
    let blobs = match parsed {
        Ok(blobs) => blobs,
        Err(error) => {
            let _ = child.kill();
            let _ = child.wait();
            let _ = stderr_reader.join();
            return Err(error);
        }
    };
    let status = child.wait().map_err(SourceWorkflowError::GitUnavailable)?;
    let stderr = join_capture(stderr_reader, "commit blob read", "stderr")?;
    if !status.success() {
        return Err(SourceWorkflowError::GitFailed {
            operation: "commit blob read",
            detail: diagnostic_detail(&stderr),
        });
    }
    Ok(blobs)
}

fn git_blob_object_id(bytes: &[u8], object_id_chars: usize) -> Result<String, SourceWorkflowError> {
    let header = format!("blob {}\0", bytes.len());
    match object_id_chars {
        40 => {
            let mut hasher = Sha1::new();
            hasher.update(header.as_bytes());
            hasher.update(bytes);
            Ok(format!("{:x}", hasher.finalize()))
        }
        64 => {
            let mut hasher = Sha256::new();
            hasher.update(header.as_bytes());
            hasher.update(bytes);
            Ok(format!("{:x}", hasher.finalize()))
        }
        _ => Err(git_failed(
            "commit blob read",
            format!("unsupported Git object id length {object_id_chars}"),
        )),
    }
}

fn git_failed(operation: &'static str, detail: impl Into<String>) -> SourceWorkflowError {
    SourceWorkflowError::GitFailed {
        operation,
        detail: detail.into(),
    }
}

fn git_text(
    root: &Path,
    args: &[&str],
    operation: &'static str,
) -> Result<String, SourceWorkflowError> {
    let output = git_bytes(root, args, operation)?;
    String::from_utf8(output).map_err(|error| SourceWorkflowError::GitFailed {
        operation,
        detail: error.to_string(),
    })
}

fn git_bytes(
    root: &Path,
    args: &[&str],
    operation: &'static str,
) -> Result<Vec<u8>, SourceWorkflowError> {
    let mut command = Command::new("git");
    isolate_git(&mut command);
    command.arg("-C").arg(root).args(args);
    bounded_command_bytes(&mut command, operation, MAX_GIT_METADATA_BYTES)
}

fn bounded_command_bytes(
    command: &mut Command,
    operation: &'static str,
    stdout_limit: usize,
) -> Result<Vec<u8>, SourceWorkflowError> {
    let mut child = command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(SourceWorkflowError::GitUnavailable)?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| SourceWorkflowError::GitFailed {
            operation,
            detail: "Git did not expose stdout".to_owned(),
        })?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| SourceWorkflowError::GitFailed {
            operation,
            detail: "Git did not expose stderr".to_owned(),
        })?;
    let stdout_reader = std::thread::spawn(move || drain_bounded(stdout, stdout_limit));
    let stderr_reader = std::thread::spawn(move || drain_bounded(stderr, MAX_GIT_DIAGNOSTIC_BYTES));
    let status = child.wait().map_err(SourceWorkflowError::GitUnavailable)?;
    let stdout = join_capture(stdout_reader, operation, "stdout")?;
    let stderr = join_capture(stderr_reader, operation, "stderr")?;
    if stdout.exceeded {
        return Err(SourceWorkflowError::SourceTooLarge(format!(
            "Git {operation} metadata exceeds {stdout_limit} bytes"
        )));
    }
    if !status.success() {
        let detail = diagnostic_detail(&stderr);
        return Err(SourceWorkflowError::GitFailed { operation, detail });
    }
    Ok(stdout.bytes)
}

/// Make repository inspection independent of user, system, and inherited Git
/// configuration. These calls are read-only and never need transport,
/// credentials, hooks, templates, or an external filesystem monitor.
pub(super) fn isolate_git(command: &mut Command) {
    const NULL_DEVICE: &str = if cfg!(windows) { "NUL" } else { "/dev/null" };
    clear_to_git_process_allowlist(command);
    command
        .env("HOME", NULL_DEVICE)
        .env("XDG_CONFIG_HOME", NULL_DEVICE)
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_ATTR_NOSYSTEM", "1")
        .env("GIT_CONFIG_GLOBAL", NULL_DEVICE)
        .env("GIT_ALLOW_PROTOCOL", "")
        .env("GIT_NO_LAZY_FETCH", "1")
        .env("GIT_NO_REPLACE_OBJECTS", "1")
        .env("GIT_PROTOCOL_FROM_USER", "0")
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GCM_INTERACTIVE", "Never")
        .env("GIT_ASKPASS", NULL_DEVICE)
        .env("SSH_ASKPASS", NULL_DEVICE)
        .env("SSH_ASKPASS_REQUIRE", "never")
        .env("GIT_CONFIG_COUNT", "10")
        .env("GIT_CONFIG_KEY_0", "core.hooksPath")
        .env("GIT_CONFIG_VALUE_0", NULL_DEVICE)
        .env("GIT_CONFIG_KEY_1", "init.templateDir")
        .env("GIT_CONFIG_VALUE_1", NULL_DEVICE)
        .env("GIT_CONFIG_KEY_2", "core.attributesFile")
        .env("GIT_CONFIG_VALUE_2", NULL_DEVICE)
        .env("GIT_CONFIG_KEY_3", "protocol.ext.allow")
        .env("GIT_CONFIG_VALUE_3", "never")
        .env("GIT_CONFIG_KEY_4", "protocol.file.allow")
        .env("GIT_CONFIG_VALUE_4", "never")
        .env("GIT_CONFIG_KEY_5", "credential.interactive")
        .env("GIT_CONFIG_VALUE_5", "never")
        .env("GIT_CONFIG_KEY_6", "credential.helper")
        .env("GIT_CONFIG_VALUE_6", "")
        .env("GIT_CONFIG_KEY_7", "core.fsmonitor")
        .env("GIT_CONFIG_VALUE_7", "false")
        .env("GIT_CONFIG_KEY_8", "core.sshCommand")
        .env("GIT_CONFIG_VALUE_8", NULL_DEVICE)
        .env("GIT_CONFIG_KEY_9", "core.useReplaceRefs")
        .env("GIT_CONFIG_VALUE_9", "false");
}

fn clear_to_git_process_allowlist(command: &mut Command) {
    command.env_clear();
    if let Some(path) = env::var_os("PATH") {
        command.env("PATH", path);
    }
    // A valid SystemRoot is required for Windows side-by-side assemblies.
    #[cfg(windows)]
    if let Some(system_root) = env::var_os("SYSTEMROOT") {
        command.env("SYSTEMROOT", system_root);
    }
}

pub(crate) fn source_digest(files: &[TrackedSourceFile<'_>]) -> String {
    let mut hasher = blake3::Hasher::new();
    hasher.update(b"somite-source-manifest-v1\0");
    for file in files {
        update_framed(&mut hasher, file.manifest.path.as_bytes());
        hasher.update(&file.manifest.mode.to_le_bytes());
        hasher.update(&file.manifest.bytes.to_le_bytes());
        update_framed(&mut hasher, &file.bytes);
    }
    format!("blake3:{}", hasher.finalize().to_hex())
}

fn update_framed(hasher: &mut blake3::Hasher, bytes: &[u8]) {
    hasher.update(&(bytes.len() as u64).to_le_bytes());
    hasher.update(bytes);
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;
    use std::env;
    use std::fs;
    use std::path::PathBuf;
    use std::process::Command;

    use tempfile::TempDir;

    use super::{
        bounded_command_bytes, clear_to_git_process_allowlist, git_blob_object_id, parse_tree,
        validate_file_count, MAX_SOURCE_BYTES, MAX_TRACKED_FILES, MAX_TRACKED_FILE_BYTES,
    };
    use crate::model::{LoadLocalRequest, SourceWorkflowError};
    use crate::{freeze_local, load_local};
    use somite_ir::SourceProvider;

    #[test]
    fn commit_tree_bounds_are_enforced_before_blob_reads() {
        let oversized = format!(
            "100644 blob {} {}\tmain.nf\0",
            "a".repeat(40),
            MAX_TRACKED_FILE_BYTES + 1
        );
        assert!(matches!(
            parse_tree(oversized.as_bytes()),
            Err(SourceWorkflowError::SourceTooLarge(_))
        ));

        let mut total = String::new();
        for index in 0..=(MAX_SOURCE_BYTES / MAX_TRACKED_FILE_BYTES) {
            total.push_str(&format!(
                "100644 blob {index:040x} {}\tfile-{index}.nf\0",
                MAX_TRACKED_FILE_BYTES
            ));
        }
        assert!(matches!(
            parse_tree(total.as_bytes()),
            Err(SourceWorkflowError::SourceTooLarge(_))
        ));
        assert!(matches!(
            validate_file_count(MAX_TRACKED_FILES + 1),
            Err(SourceWorkflowError::SourceTooLarge(_))
        ));
    }

    #[test]
    fn blob_object_ids_are_verified_for_sha1_and_sha256_repositories() {
        assert_eq!(
            git_blob_object_id(b"hello", 40).expect("SHA-1 Git blob"),
            "b6fc4c620b67d95f953a5c1c1230aaab5db5a1b0"
        );
        assert_eq!(
            git_blob_object_id(b"hello", 64).expect("SHA-256 Git blob"),
            "8aec4e4876f854f688d0ebfc8f37598f38e5fd6903cccc850ca36591175aeb60"
        );
    }

    #[test]
    fn git_process_environment_contains_only_the_launch_allowlist() {
        let mut command = Command::new("git");
        command.env("SOMITE_SOURCE_TEST_UNSAFE_INHERITED", "present");
        clear_to_git_process_allowlist(&mut command);

        let variables = command
            .get_envs()
            .map(|(key, value)| {
                (
                    key.to_owned(),
                    value.expect("allowlisted environment value").to_owned(),
                )
            })
            .collect::<BTreeMap<_, _>>();
        assert_eq!(
            variables.get(std::ffi::OsStr::new("PATH")),
            env::var_os("PATH").as_ref()
        );
        #[cfg(windows)]
        assert_eq!(
            variables.get(std::ffi::OsStr::new("SYSTEMROOT")),
            env::var_os("SYSTEMROOT").as_ref()
        );
        let expected_count = usize::from(env::var_os("PATH").is_some())
            + if cfg!(windows) {
                usize::from(env::var_os("SYSTEMROOT").is_some())
            } else {
                0
            };
        assert_eq!(variables.len(), expected_count);
        assert!(
            !variables.contains_key(std::ffi::OsStr::new("SOMITE_SOURCE_TEST_UNSAFE_INHERITED"))
        );
    }

    #[cfg(unix)]
    #[test]
    fn git_process_environment_does_not_inherit_parent_variables() {
        let mut command = Command::new("env");
        command.env("SOMITE_SOURCE_TEST_UNSAFE_INHERITED", "present");
        clear_to_git_process_allowlist(&mut command);
        let output = command
            .output()
            .expect("run process with allowlisted environment");
        assert!(output.status.success());
        let inherited = String::from_utf8_lossy(&output.stdout);
        assert_eq!(
            inherited.lines().count(),
            usize::from(env::var_os("PATH").is_some())
        );
        assert!(!inherited.contains("SOMITE_SOURCE_TEST_UNSAFE_INHERITED="));
    }

    #[cfg(unix)]
    #[test]
    fn substituted_loose_blob_is_rejected_even_when_git_echoes_the_requested_oid() {
        let temporary = TempDir::new().expect("temporary Git fixture");
        let repository = temporary.path().join("repository");
        fs::create_dir(&repository).expect("repository directory");
        run_fixture_git(&repository, &["init", "--quiet"]);
        fs::write(repository.join("main.nf"), b"workflow {}\n").expect("entrypoint");
        run_fixture_git(&repository, &["add", "main.nf"]);
        run_fixture_git(
            &repository,
            &[
                "-c",
                "user.name=Somite Test",
                "-c",
                "user.email=somite@example.invalid",
                "commit",
                "--quiet",
                "-m",
                "fixture",
            ],
        );
        let revision = fixture_git_text(&repository, &["rev-parse", "HEAD"]);
        let original = fixture_git_text(&repository, &["rev-parse", "HEAD:main.nf"]);
        fs::write(repository.join("substitute.bin"), b"workfloX {}\n")
            .expect("same-size substitute blob");
        let substitute = fixture_git_text(&repository, &["hash-object", "-w", "substitute.bin"]);
        let object_path = |object: &str| {
            repository
                .join(".git/objects")
                .join(&object[..2])
                .join(&object[2..])
        };
        fs::remove_file(object_path(&original)).expect("remove original loose-object payload");
        fs::copy(object_path(&substitute), object_path(&original))
            .expect("substitute valid loose-object payload under requested oid");

        let error = load_local(&LoadLocalRequest {
            root: repository,
            provider: SourceProvider::Local,
            repository: "local/corrupt-blob-test".to_owned(),
            requested_revision: revision.clone(),
            expected_resolved_revision: revision,
            entrypoint: "main.nf".to_owned(),
            profiles: Vec::new(),
        })
        .expect_err("substituted blob must fail independent object hashing");
        assert!(matches!(
            error,
            SourceWorkflowError::SourceChanged { expected, actual }
                if expected.contains(&original) && actual.contains(&substitute)
        ));
    }

    #[cfg(unix)]
    #[test]
    fn commit_tree_output_and_diagnostics_are_captured_with_strict_bounds() {
        let mut oversized = Command::new("sh");
        oversized.args(["-c", "head -c 131072 /dev/zero >&2; head -c 4097 /dev/zero"]);
        assert!(matches!(
            bounded_command_bytes(&mut oversized, "commit-tree listing", 4096),
            Err(SourceWorkflowError::SourceTooLarge(detail))
                if detail.contains("commit-tree listing") && detail.contains("4096")
        ));

        let mut noisy_success = Command::new("sh");
        noisy_success.args(["-c", "head -c 131072 /dev/zero >&2; printf bounded-output"]);
        assert_eq!(
            bounded_command_bytes(&mut noisy_success, "diagnostic drain", 4096)
                .expect("large stderr is drained without retaining it"),
            b"bounded-output"
        );
    }

    #[cfg(unix)]
    #[test]
    fn batch_blob_read_completes_with_a_large_first_blob_and_many_queries() {
        let temporary = TempDir::new().expect("temporary Git fixture");
        let repository = temporary.path().join("repository");
        fs::create_dir(&repository).expect("repository directory");
        run_fixture_git(&repository, &["init", "--quiet"]);
        fs::write(repository.join("000-large.bin"), vec![b'x'; 1024 * 1024])
            .expect("large first blob");
        fs::write(repository.join("main.nf"), b"workflow {}\n").expect("entrypoint");
        for index in 0..256 {
            fs::write(
                repository.join(format!("small-{index:03}.txt")),
                format!("{index}\n"),
            )
            .expect("small tracked blob");
        }
        run_fixture_git(&repository, &["add", "."]);
        run_fixture_git(
            &repository,
            &[
                "-c",
                "user.name=Somite Test",
                "-c",
                "user.email=somite@example.invalid",
                "commit",
                "--quiet",
                "-m",
                "fixture",
            ],
        );
        let revision = fixture_git_text(&repository, &["rev-parse", "HEAD"]);
        let loaded = load_local(&LoadLocalRequest {
            root: repository,
            provider: SourceProvider::Local,
            repository: "local/batch-concurrency-test".to_owned(),
            requested_revision: revision.clone(),
            expected_resolved_revision: revision,
            entrypoint: "main.nf".to_owned(),
            profiles: Vec::new(),
        })
        .expect("large-first batch read");
        assert_eq!(loaded.source_manifest.files.len(), 258);
        assert_eq!(loaded.workflow.source.source_bytes, 1_049_502);
    }

    #[cfg(unix)]
    #[test]
    fn public_source_reads_use_commit_blobs_without_running_filters_or_fsmonitor() {
        const CHILD: &str = "SOMITE_SOURCE_TEST_HOSTILE_GIT_CHILD";
        const ROOT: &str = "SOMITE_SOURCE_TEST_HOSTILE_GIT_ROOT";
        const REVISION: &str = "SOMITE_SOURCE_TEST_HOSTILE_GIT_REVISION";
        const FILTER_MARKER: &str = "SOMITE_SOURCE_TEST_HOSTILE_FILTER_MARKER";
        const FSMONITOR_MARKER: &str = "SOMITE_SOURCE_TEST_HOSTILE_FSMONITOR_MARKER";

        if std::env::var_os(CHILD).is_some() {
            let root = PathBuf::from(std::env::var_os(ROOT).expect("child repository root"));
            let revision = std::env::var(REVISION).expect("child revision");
            let filter_marker =
                PathBuf::from(std::env::var_os(FILTER_MARKER).expect("child filter marker"));
            let fsmonitor_marker =
                PathBuf::from(std::env::var_os(FSMONITOR_MARKER).expect("child fsmonitor marker"));
            let loaded = load_local(&LoadLocalRequest {
                root: root.clone(),
                provider: SourceProvider::Local,
                repository: "local/hostile-config-test".to_owned(),
                requested_revision: revision.clone(),
                expected_resolved_revision: revision,
                entrypoint: "main.nf".to_owned(),
                profiles: Vec::new(),
            })
            .expect("source load under hostile global Git configuration");
            let frozen = freeze_local(&root, &loaded.workflow)
                .expect("source freeze under hostile global Git configuration");
            let main = frozen
                .source_files
                .iter()
                .find(|file| file.path == "main.nf")
                .expect("frozen commit entrypoint");
            assert_eq!(main.bytes, b"workflow {}\n");
            assert_eq!(
                fs::read(root.join("main.nf")).expect("raw worktree entrypoint"),
                b"workfloW {}\n",
                "the regression requires worktree bytes to differ from the commit blob"
            );
            assert!(
                !filter_marker.exists(),
                "untrusted repository-local clean filter was executed"
            );
            assert!(
                !fsmonitor_marker.exists(),
                "untrusted global core.fsmonitor was executed"
            );
            return;
        }

        use std::os::unix::fs::PermissionsExt;

        let temporary = TempDir::new().expect("temporary Git fixture");
        let repository = temporary.path().join("repository");
        fs::create_dir(&repository).expect("repository directory");
        run_fixture_git(&repository, &["init", "--quiet"]);
        fs::write(repository.join("main.nf"), b"workflow {}\n").expect("entrypoint");
        fs::write(
            repository.join(".gitattributes"),
            b"main.nf filter=hostile\n",
        )
        .expect("tracked hostile attributes");
        run_fixture_git(&repository, &["add", "main.nf", ".gitattributes"]);
        run_fixture_git(
            &repository,
            &[
                "-c",
                "user.name=Somite Test",
                "-c",
                "user.email=somite@example.invalid",
                "commit",
                "--quiet",
                "-m",
                "fixture",
            ],
        );
        let revision = fixture_git_text(&repository, &["rev-parse", "HEAD"]);

        let filter_marker = temporary.path().join("hostile-local-filter-ran");
        let filter = temporary.path().join("hostile-local-filter");
        fs::write(
            &filter,
            format!(
                "#!/bin/sh\nprintf executed > '{}'\ncat\n",
                filter_marker.display()
            ),
        )
        .expect("hostile filter fixture");
        fs::set_permissions(&filter, fs::Permissions::from_mode(0o755))
            .expect("executable hostile filter fixture");
        let filter_command = filter.display().to_string();
        run_fixture_git(
            &repository,
            &["config", "filter.hostile.clean", &filter_command],
        );
        run_fixture_git(&repository, &["config", "filter.hostile.required", "true"]);
        fs::write(repository.join("main.nf"), b"workfloW {}\n")
            .expect("divergent raw worktree entrypoint");
        run_fixture_git(&repository, &["status", "--porcelain=v1"]);
        assert!(
            filter_marker.exists(),
            "fixture must prove worktree-aware Git executes the configured clean filter"
        );
        fs::remove_file(&filter_marker).expect("reset controlled filter marker");

        let fsmonitor_marker = temporary.path().join("hostile-global-fsmonitor-ran");
        let fsmonitor = temporary.path().join("hostile-global-fsmonitor");
        fs::write(
            &fsmonitor,
            format!(
                "#!/bin/sh\nprintf executed > '{}'\nprintf 'somite-test-token\\n'\n",
                fsmonitor_marker.display()
            ),
        )
        .expect("hostile fsmonitor fixture");
        fs::set_permissions(&fsmonitor, fs::Permissions::from_mode(0o755))
            .expect("executable hostile fsmonitor fixture");
        let hostile_global = temporary.path().join("hostile-global-git-config");
        fs::write(
            &hostile_global,
            format!(
                "[core]\n\tfsmonitor = {}\n\tfsmonitorHookVersion = 2\n",
                fsmonitor.display()
            ),
        )
        .expect("hostile global Git configuration");

        let output = Command::new(std::env::current_exe().expect("source test executable"))
            .args([
                "--exact",
                "source::tests::public_source_reads_use_commit_blobs_without_running_filters_or_fsmonitor",
                "--nocapture",
            ])
            .env(CHILD, "1")
            .env(ROOT, &repository)
            .env(REVISION, &revision)
            .env(FILTER_MARKER, &filter_marker)
            .env(FSMONITOR_MARKER, &fsmonitor_marker)
            .env("GIT_CONFIG_GLOBAL", &hostile_global)
            .output()
            .expect("run isolated source child test");
        assert!(
            output.status.success(),
            "source child failed:\nstdout:\n{}\nstderr:\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(
            !filter_marker.exists(),
            "untrusted repository-local clean filter was executed"
        );
        assert!(
            !fsmonitor_marker.exists(),
            "untrusted global core.fsmonitor was executed"
        );
    }

    #[cfg(unix)]
    fn run_fixture_git(root: &std::path::Path, args: &[&str]) {
        let output = Command::new("git")
            .arg("-c")
            .arg("core.fsmonitor=false")
            .arg("-c")
            .arg("core.hooksPath=/dev/null")
            .arg("-C")
            .arg(root)
            .args(args)
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .output()
            .expect("fixture Git command");
        assert!(
            output.status.success(),
            "git {args:?}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }

    #[cfg(unix)]
    fn fixture_git_text(root: &std::path::Path, args: &[&str]) -> String {
        let output = Command::new("git")
            .arg("-C")
            .arg(root)
            .args(args)
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .output()
            .expect("fixture Git command");
        assert!(output.status.success(), "git {args:?}");
        String::from_utf8(output.stdout)
            .expect("Git UTF-8")
            .trim()
            .to_owned()
    }
}
