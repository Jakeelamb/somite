use std::collections::{BTreeMap, BTreeSet};
use std::path::{Component, Path};

use somite_ir::{SourceDiagnostic, SourceInvocation, SourceScope, SourceScopeKind, SourceSpan};

use crate::model::{DerivedProjectionBudget, SourceWorkflowError};
use crate::source::TrackedSourceFile;

const MAX_INDEXED_TOKENS: usize = 1_000_000;
const MAX_INDEXED_SCOPES: usize = 25_000;
const MAX_INDEXED_INCLUDE_BINDINGS: usize = 50_000;
const MAX_INDEXED_INVOCATIONS: usize = 50_000;
const MAX_INDEXED_DIAGNOSTICS: usize = 25_000;
const MAX_INDEXED_IDENTIFIER_BYTES: usize = 1024;

#[derive(Clone, Copy)]
struct IndexLimits {
    tokens: usize,
    scopes: usize,
    includes: usize,
    invocations: usize,
    diagnostics: usize,
}

const INDEX_LIMITS: IndexLimits = IndexLimits {
    tokens: MAX_INDEXED_TOKENS,
    scopes: MAX_INDEXED_SCOPES,
    includes: MAX_INDEXED_INCLUDE_BINDINGS,
    invocations: MAX_INDEXED_INVOCATIONS,
    diagnostics: MAX_INDEXED_DIAGNOSTICS,
};

pub(crate) struct IndexedNextflow {
    pub scopes: Vec<SourceScope>,
    pub invocations: Vec<SourceInvocation>,
    pub diagnostics: Vec<SourceDiagnostic>,
}

pub(crate) fn index_nextflow(
    files: &[TrackedSourceFile<'_>],
    entrypoint: &str,
    source_digest: &str,
    budget: &mut DerivedProjectionBudget,
) -> Result<IndexedNextflow, SourceWorkflowError> {
    index_nextflow_with_limits(files, entrypoint, source_digest, budget, INDEX_LIMITS)
}

fn index_nextflow_with_limits(
    files: &[TrackedSourceFile<'_>],
    entrypoint: &str,
    source_digest: &str,
    budget: &mut DerivedProjectionBudget,
    limits: IndexLimits,
) -> Result<IndexedNextflow, SourceWorkflowError> {
    let tracked_paths = files
        .iter()
        .map(|file| file.manifest.path.as_str())
        .collect::<BTreeSet<_>>();
    let mut diagnostics = Vec::new();
    let mut indexed_files = Vec::new();
    let mut indexed_tokens = 0_usize;
    let mut indexed_scopes = 0_usize;
    let mut indexed_includes = 0_usize;
    for file in files
        .iter()
        .filter(|file| file.manifest.path.ends_with(".nf"))
    {
        let source = match std::str::from_utf8(&file.bytes) {
            Ok(source) => source,
            Err(_) => {
                reserve_projection(
                    budget,
                    256 + "non_utf8_nextflow_source".len()
                        + " is retained exactly but cannot be indexed as UTF-8.".len()
                        + file.manifest.path.len(),
                    "outline diagnostics",
                )?;
                push_bounded(
                    &mut diagnostics,
                    SourceDiagnostic {
                        code: "non_utf8_nextflow_source".to_owned(),
                        message: format!(
                            "{} is retained exactly but cannot be indexed as UTF-8.",
                            file.manifest.path
                        ),
                        span: None,
                    },
                    limits.diagnostics,
                    "diagnostics",
                )?;
                continue;
            }
        };
        let indexed = index_file(
            &file.manifest.path,
            source,
            entrypoint,
            source_digest,
            &tracked_paths,
            budget,
            IndexLimits {
                tokens: limits.tokens.saturating_sub(indexed_tokens),
                scopes: limits.scopes.saturating_sub(indexed_scopes),
                includes: limits.includes.saturating_sub(indexed_includes),
                invocations: 0,
                diagnostics: 0,
            },
        )?;
        indexed_tokens += indexed.tokens.len();
        indexed_scopes += indexed.scopes.len();
        indexed_includes += indexed.includes.len();
        indexed_files.push(indexed);
    }

    let mut scope_lookup = BTreeMap::<String, BTreeMap<String, Vec<String>>>::new();
    for file in &indexed_files {
        for scope in &file.scopes {
            if let Some(symbol) = &scope.public.symbol {
                scope_lookup
                    .entry(file.path.clone())
                    .or_default()
                    .entry(symbol.clone())
                    .or_default()
                    .push(scope.public.id.clone());
            }
        }
    }

    let mut invocations = Vec::new();
    for file in &indexed_files {
        let aliases = file
            .includes
            .iter()
            .map(|include| (include.alias.as_str(), include))
            .collect::<BTreeMap<_, _>>();
        // Assign each token to its innermost lexical scope in one pass. This
        // avoids duplicate calls from nested scopes and bounds the work to
        // O(tokens + scopes), even for adversarially nested source.
        let mut active_scopes = Vec::<usize>::new();
        let mut next_scope = 0_usize;
        for token_index in 0..file.tokens.len() {
            while active_scopes
                .last()
                .is_some_and(|scope| file.scopes[*scope].close_token <= token_index)
            {
                active_scopes.pop();
            }
            while file
                .scopes
                .get(next_scope)
                .is_some_and(|scope| scope.open_token < token_index)
            {
                active_scopes.push(next_scope);
                next_scope += 1;
            }
            let Some(scope) = active_scopes.last().map(|scope| &file.scopes[*scope]) else {
                continue;
            };
            if !matches!(
                scope.public.kind,
                SourceScopeKind::EntryWorkflow | SourceScopeKind::Workflow
            ) {
                continue;
            }
            let Some(name) = file.tokens[token_index].identifier(file.source) else {
                continue;
            };
            let Some(next) = file.tokens.get(token_index + 1) else {
                break;
            };
            if !matches!(next.kind, TokenKind::LeftParen)
                || token_index
                    .checked_sub(1)
                    .and_then(|index| file.tokens.get(index))
                    .is_some_and(|token| matches!(token.kind, TokenKind::Dot))
            {
                continue;
            }

            let alias = aliases.get(name).copied();
            let local = scope_lookup
                .get(file.path.as_str())
                .and_then(|scopes| scopes.get(name));
            if alias.is_none() && local.is_none() {
                continue;
            }

            let callee = if let Some(include) = alias {
                include.target_path.as_ref().and_then(|target_path| {
                    unique(
                        scope_lookup
                            .get(target_path.as_str())
                            .and_then(|scopes| scopes.get(include.symbol.as_str())),
                    )
                })
            } else {
                unique(local)
            };
            let end_token =
                paired_token(&file.paren_pairs, token_index + 1).unwrap_or(token_index + 1);
            let span = SourceSpan {
                path: file.path.clone(),
                start_line: file.tokens[token_index].line,
                end_line: file.tokens[end_token].end_line,
            };
            let id = stable_id(
                "invocation",
                &[
                    source_digest,
                    scope.public.id.as_str(),
                    name,
                    &file.tokens[token_index].offset.to_string(),
                ],
            );
            if callee.is_none() {
                reserve_projection(
                    budget,
                    256 + "source_only_invocation".len()
                        + name.len()
                        + " is retained as an exact source invocation; no local workflow or process declaration was resolved.".len()
                        + file.path.len(),
                    "outline diagnostics",
                )?;
                push_bounded(
                    &mut diagnostics,
                    SourceDiagnostic {
                        code: "source_only_invocation".to_owned(),
                        message: format!(
                            "{name} is retained as an exact source invocation; no local workflow or process declaration was resolved."
                        ),
                        span: Some(span.clone()),
                    },
                    limits.diagnostics,
                    "diagnostics",
                )?;
            }
            reserve_projection(
                budget,
                256 + id.len()
                    + scope.public.id.len()
                    + name.len()
                    + callee.as_ref().map_or(0, String::len)
                    + file.path.len(),
                "invocations",
            )?;
            push_bounded(
                &mut invocations,
                SourceInvocation {
                    id,
                    caller: scope.public.id.clone(),
                    name: name.to_owned(),
                    callee,
                    span,
                },
                limits.invocations,
                "invocations",
            )?;
        }
    }

    let mut scopes = indexed_files
        .into_iter()
        .flat_map(|file| file.scopes.into_iter().map(|scope| scope.public))
        .collect::<Vec<_>>();
    scopes.sort_by(|left, right| {
        left.span
            .path
            .cmp(&right.span.path)
            .then_with(|| left.span.start_line.cmp(&right.span.start_line))
            .then_with(|| left.id.cmp(&right.id))
    });
    invocations.sort_by(|left, right| {
        left.span
            .path
            .cmp(&right.span.path)
            .then_with(|| left.span.start_line.cmp(&right.span.start_line))
            .then_with(|| left.id.cmp(&right.id))
    });

    Ok(IndexedNextflow {
        scopes,
        invocations,
        diagnostics,
    })
}

fn reserve_projection(
    budget: &mut DerivedProjectionBudget,
    bytes: usize,
    kind: &str,
) -> Result<(), SourceWorkflowError> {
    budget.reserve(bytes, kind)
}

fn push_bounded<T>(
    values: &mut Vec<T>,
    value: T,
    limit: usize,
    kind: &str,
) -> Result<(), SourceWorkflowError> {
    if values.len() >= limit {
        return Err(SourceWorkflowError::SourceTooLarge(format!(
            "source outline exceeds {limit} indexed {kind}"
        )));
    }
    values.push(value);
    Ok(())
}

fn unique(values: Option<&Vec<String>>) -> Option<String> {
    values.and_then(|values| (values.len() == 1).then(|| values[0].clone()))
}

struct IndexedFile<'source> {
    path: String,
    source: &'source str,
    tokens: Vec<Token>,
    scopes: Vec<IndexedScope>,
    includes: Vec<IncludeBinding>,
    paren_pairs: Vec<(usize, usize)>,
}

struct IndexedScope {
    public: SourceScope,
    open_token: usize,
    close_token: usize,
}

struct IncludeBinding {
    alias: String,
    symbol: String,
    target_path: Option<String>,
}

fn index_file<'source>(
    path: &str,
    source: &'source str,
    entrypoint: &str,
    source_digest: &str,
    tracked_paths: &BTreeSet<&str>,
    budget: &mut DerivedProjectionBudget,
    limits: IndexLimits,
) -> Result<IndexedFile<'source>, SourceWorkflowError> {
    let tokens = tokenize(source, limits.tokens)?;
    let brace_pairs = token_pairs(&tokens, PairKind::Brace);
    let paren_pairs = token_pairs(&tokens, PairKind::Paren);
    let mut scopes = Vec::new();
    for (index, token) in tokens.iter().enumerate() {
        let Some(keyword) = token.identifier(source) else {
            continue;
        };
        let (kind, symbol, open_token) = if keyword == "process" {
            match (tokens.get(index + 1), tokens.get(index + 2)) {
                (Some(name), Some(open)) if matches!(open.kind, TokenKind::LeftBrace) => {
                    let Some(symbol) = name.identifier(source) else {
                        continue;
                    };
                    (SourceScopeKind::Process, Some(symbol.to_owned()), index + 2)
                }
                _ => continue,
            }
        } else if keyword == "workflow" {
            match (tokens.get(index + 1), tokens.get(index + 2)) {
                (Some(open), _) if matches!(open.kind, TokenKind::LeftBrace) => (
                    if path == entrypoint {
                        SourceScopeKind::EntryWorkflow
                    } else {
                        SourceScopeKind::Workflow
                    },
                    None,
                    index + 1,
                ),
                (Some(name), Some(open)) if matches!(open.kind, TokenKind::LeftBrace) => {
                    let Some(symbol) = name.identifier(source) else {
                        continue;
                    };
                    (
                        SourceScopeKind::Workflow,
                        Some(symbol.to_owned()),
                        index + 2,
                    )
                }
                _ => continue,
            }
        } else {
            continue;
        };
        let Some(close_token) = paired_token(&brace_pairs, open_token) else {
            continue;
        };
        let symbol_key = symbol.as_deref().unwrap_or("<entry>");
        let kind_key = match kind {
            SourceScopeKind::EntryWorkflow => "entry_workflow",
            SourceScopeKind::Workflow => "workflow",
            SourceScopeKind::Process => "process",
        };
        let id = stable_id(
            "scope",
            &[
                source_digest,
                path,
                kind_key,
                symbol_key,
                &token.offset.to_string(),
            ],
        );
        reserve_projection(
            budget,
            256 + id.len()
                + symbol.as_ref().map_or("Entry workflow".len(), String::len)
                + symbol.as_ref().map_or(0, String::len)
                + path.len(),
            "scopes",
        )?;
        push_bounded(
            &mut scopes,
            IndexedScope {
                public: SourceScope {
                    id,
                    title: symbol
                        .clone()
                        .unwrap_or_else(|| "Entry workflow".to_owned()),
                    symbol,
                    kind,
                    span: SourceSpan {
                        path: path.to_owned(),
                        start_line: token.line,
                        end_line: tokens[close_token].end_line,
                    },
                },
                open_token,
                close_token,
            },
            limits.scopes,
            "scopes",
        )?;
    }

    let includes = parse_includes(
        path,
        source,
        &tokens,
        &brace_pairs,
        tracked_paths,
        budget,
        limits.includes,
    )?;
    reserve_projection(budget, 128 + path.len(), "indexed files")?;
    Ok(IndexedFile {
        path: path.to_owned(),
        source,
        tokens,
        scopes,
        includes,
        paren_pairs,
    })
}

fn parse_includes(
    current_path: &str,
    source_text: &str,
    tokens: &[Token],
    brace_pairs: &[(usize, usize)],
    tracked_paths: &BTreeSet<&str>,
    budget: &mut DerivedProjectionBudget,
    limit: usize,
) -> Result<Vec<IncludeBinding>, SourceWorkflowError> {
    let mut includes = Vec::new();
    for (index, token) in tokens.iter().enumerate() {
        if token.identifier(source_text) != Some("include")
            || !tokens
                .get(index + 1)
                .is_some_and(|token| matches!(token.kind, TokenKind::LeftBrace))
        {
            continue;
        }
        let open = index + 1;
        let Some(close) = paired_token(brace_pairs, open) else {
            continue;
        };
        let source = match (tokens.get(close + 1), tokens.get(close + 2)) {
            (Some(from), Some(source)) if from.identifier(source_text) == Some("from") => {
                source.string(source_text)
            }
            _ => None,
        };
        let target_path =
            source.and_then(|source| resolve_include_path(current_path, source, tracked_paths));

        let mut cursor = open + 1;
        while cursor < close {
            let Some(symbol) = tokens[cursor].identifier(source_text) else {
                cursor += 1;
                continue;
            };
            if symbol == "as" {
                cursor += 1;
                continue;
            }
            let mut alias = symbol;
            if tokens
                .get(cursor + 1)
                .and_then(|token| token.identifier(source_text))
                == Some("as")
            {
                if let Some(value) = tokens
                    .get(cursor + 2)
                    .and_then(|token| token.identifier(source_text))
                {
                    alias = value;
                    cursor += 2;
                }
            }
            reserve_projection(
                budget,
                192 + alias.len() + symbol.len() + target_path.as_ref().map_or(0, String::len),
                "include bindings",
            )?;
            push_bounded(
                &mut includes,
                IncludeBinding {
                    alias: alias.to_owned(),
                    symbol: symbol.to_owned(),
                    target_path: target_path.clone(),
                },
                limit,
                "include bindings",
            )?;
            cursor += 1;
        }
    }
    Ok(includes)
}

fn resolve_include_path(
    current_path: &str,
    source: &str,
    tracked_paths: &BTreeSet<&str>,
) -> Option<String> {
    if !(source.starts_with("./") || source.starts_with("../")) {
        return None;
    }
    let parent = Path::new(current_path)
        .parent()
        .unwrap_or_else(|| Path::new(""));
    let mut parts = Vec::<String>::new();
    for component in parent.components().chain(Path::new(source).components()) {
        match component {
            Component::Normal(part) => parts.push(part.to_string_lossy().into_owned()),
            Component::ParentDir => {
                parts.pop()?;
            }
            Component::CurDir => {}
            Component::RootDir | Component::Prefix(_) => return None,
        }
    }
    let base = parts.join("/");
    [
        base.clone(),
        format!("{base}.nf"),
        format!("{base}/main.nf"),
    ]
    .into_iter()
    .find(|candidate| tracked_paths.contains(candidate.as_str()))
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Token {
    kind: TokenKind,
    text_start: usize,
    text_end: usize,
    line: u32,
    end_line: u32,
    offset: usize,
}

impl Token {
    fn identifier<'source>(&self, source: &'source str) -> Option<&'source str> {
        matches!(self.kind, TokenKind::Ident)
            .then(|| source.get(self.text_start..self.text_end))
            .flatten()
    }

    fn string<'source>(&self, source: &'source str) -> Option<&'source str> {
        matches!(self.kind, TokenKind::String)
            .then(|| source.get(self.text_start..self.text_end))
            .flatten()
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum TokenKind {
    Ident,
    String,
    LeftBrace,
    RightBrace,
    LeftParen,
    RightParen,
    Dot,
    Semicolon,
}

fn tokenize(source: &str, limit: usize) -> Result<Vec<Token>, SourceWorkflowError> {
    let bytes = source.as_bytes();
    let mut tokens = Vec::new();
    let mut index = 0;
    let mut line = 1_u32;
    while index < bytes.len() {
        match bytes[index] {
            b'\n' => {
                line += 1;
                index += 1;
            }
            byte if byte.is_ascii_whitespace() => index += 1,
            b'/' if bytes.get(index + 1) == Some(&b'/') => {
                index += 2;
                while index < bytes.len() && bytes[index] != b'\n' {
                    index += 1;
                }
            }
            b'/' if bytes.get(index + 1) == Some(&b'*') => {
                index += 2;
                while index + 1 < bytes.len() {
                    if bytes[index] == b'\n' {
                        line += 1;
                    }
                    if bytes[index] == b'*' && bytes[index + 1] == b'/' {
                        index += 2;
                        break;
                    }
                    index += 1;
                }
            }
            quote @ (b'\'' | b'"') => {
                let start = index;
                let start_line = line;
                let triple = bytes.get(index..index + 3) == Some(&[quote, quote, quote]);
                index += if triple { 3 } else { 1 };
                let content_start = index;
                let mut content_end = index;
                while index < bytes.len() {
                    if bytes[index] == b'\n' {
                        line += 1;
                    }
                    if triple && bytes.get(index..index + 3) == Some(&[quote, quote, quote]) {
                        content_end = index;
                        index += 3;
                        break;
                    }
                    if !triple && bytes[index] == quote {
                        content_end = index;
                        index += 1;
                        break;
                    }
                    if !triple && bytes[index] == b'\\' && index + 1 < bytes.len() {
                        index += 2;
                    } else {
                        index += 1;
                    }
                }
                if !triple {
                    push_bounded(
                        &mut tokens,
                        Token {
                            kind: TokenKind::String,
                            text_start: content_start,
                            text_end: content_end,
                            line: start_line,
                            end_line: line,
                            offset: start,
                        },
                        limit,
                        "tokens",
                    )?;
                }
            }
            byte if byte.is_ascii_alphabetic() || byte == b'_' => {
                let start = index;
                index += 1;
                while index < bytes.len()
                    && (bytes[index].is_ascii_alphanumeric() || bytes[index] == b'_')
                {
                    index += 1;
                }
                if index - start > MAX_INDEXED_IDENTIFIER_BYTES {
                    return Err(SourceWorkflowError::SourceTooLarge(format!(
                        "Nextflow identifier exceeds {MAX_INDEXED_IDENTIFIER_BYTES} bytes"
                    )));
                }
                push_bounded(
                    &mut tokens,
                    Token {
                        kind: TokenKind::Ident,
                        text_start: start,
                        text_end: index,
                        line,
                        end_line: line,
                        offset: start,
                    },
                    limit,
                    "tokens",
                )?;
            }
            symbol => {
                let kind = match symbol {
                    b'{' => Some(TokenKind::LeftBrace),
                    b'}' => Some(TokenKind::RightBrace),
                    b'(' => Some(TokenKind::LeftParen),
                    b')' => Some(TokenKind::RightParen),
                    b'.' => Some(TokenKind::Dot),
                    b';' => Some(TokenKind::Semicolon),
                    _ => None,
                };
                if let Some(kind) = kind {
                    push_bounded(
                        &mut tokens,
                        Token {
                            kind,
                            text_start: index,
                            text_end: index,
                            line,
                            end_line: line,
                            offset: index,
                        },
                        limit,
                        "tokens",
                    )?;
                }
                index += 1;
            }
        }
    }
    Ok(tokens)
}

#[derive(Clone, Copy)]
enum PairKind {
    Brace,
    Paren,
}

fn token_pairs(tokens: &[Token], kind: PairKind) -> Vec<(usize, usize)> {
    let pair_capacity = tokens
        .iter()
        .filter(|token| is_open(token.kind, kind))
        .count();
    let mut stack = Vec::with_capacity(pair_capacity);
    let mut pairs = Vec::with_capacity(pair_capacity);
    for (index, token) in tokens.iter().enumerate() {
        if is_open(token.kind, kind) {
            stack.push(index);
        } else if is_close(token.kind, kind) {
            if let Some(open) = stack.pop() {
                pairs.push((open, index));
            }
        }
    }
    pairs.sort_unstable_by_key(|(open, _)| *open);
    pairs
}

fn is_open(token: TokenKind, kind: PairKind) -> bool {
    match kind {
        PairKind::Brace => matches!(token, TokenKind::LeftBrace),
        PairKind::Paren => matches!(token, TokenKind::LeftParen),
    }
}

fn is_close(token: TokenKind, kind: PairKind) -> bool {
    match kind {
        PairKind::Brace => matches!(token, TokenKind::RightBrace),
        PairKind::Paren => matches!(token, TokenKind::RightParen),
    }
}

fn paired_token(pairs: &[(usize, usize)], open: usize) -> Option<usize> {
    pairs
        .binary_search_by_key(&open, |(candidate, _)| *candidate)
        .ok()
        .map(|index| pairs[index].1)
}

fn stable_id(namespace: &str, parts: &[&str]) -> String {
    let mut hasher = blake3::Hasher::new();
    hasher.update(b"somite-source-outline-v1\0");
    for part in parts {
        hasher.update(&(part.len() as u64).to_le_bytes());
        hasher.update(part.as_bytes());
    }
    format!("{namespace}:{}", hasher.finalize().to_hex())
}

#[cfg(test)]
mod tests {
    use somite_ir::SourceScopeKind;

    use super::{
        index_nextflow, index_nextflow_with_limits, paired_token, token_pairs, tokenize,
        IndexLimits, PairKind, TokenKind, MAX_INDEXED_IDENTIFIER_BYTES,
    };
    use crate::model::{DerivedProjectionBudget, SourceFileManifest, SourceWorkflowError};
    use crate::source::TrackedSourceFile;

    #[test]
    fn lexer_text_is_borrowed_and_comments_and_scripts_stay_opaque() {
        let source = "workflow TOP {\n\
            // process LINE_COMMENT {}\n\
            call('value\\'s\ncontinued')\n\
            /* workflow BLOCK_COMMENT {} */\n\
            \"\"\"\n\
            process SCRIPT_BODY {}\n\
            \"\"\"\n\
            }\n";

        let tokens = tokenize(source, 1_000).expect("bounded tokens");
        let identifiers = tokens
            .iter()
            .filter_map(|token| token.identifier(source))
            .collect::<Vec<_>>();
        assert_eq!(identifiers, ["workflow", "TOP", "call"]);

        let string = tokens
            .iter()
            .find(|token| matches!(token.kind, TokenKind::String))
            .expect("single quoted string");
        assert_eq!(string.string(source), Some("value\\'s\ncontinued"));
        assert_eq!((string.line, string.end_line), (3, 4));

        let workflow = tokens[0].identifier(source).expect("workflow token");
        assert_eq!(workflow.as_ptr(), source.as_ptr());
        let closing = tokens
            .iter()
            .rfind(|token| matches!(token.kind, TokenKind::RightBrace))
            .expect("workflow close");
        assert_eq!((closing.line, closing.end_line), (9, 9));
    }

    #[test]
    fn token_pairs_retain_nested_open_to_close_lookup() {
        let tokens = tokenize("workflow NESTED { CALL((value)) }", 1_000).expect("bounded tokens");
        let braces = token_pairs(&tokens, PairKind::Brace);
        let parens = token_pairs(&tokens, PairKind::Paren);

        let open_brace = tokens
            .iter()
            .position(|token| matches!(token.kind, TokenKind::LeftBrace))
            .expect("open brace");
        let close_brace = tokens
            .iter()
            .position(|token| matches!(token.kind, TokenKind::RightBrace))
            .expect("close brace");
        assert_eq!(paired_token(&braces, open_brace), Some(close_brace));

        let open_parens = tokens
            .iter()
            .enumerate()
            .filter_map(|(index, token)| {
                matches!(token.kind, TokenKind::LeftParen).then_some(index)
            })
            .collect::<Vec<_>>();
        let close_parens = tokens
            .iter()
            .enumerate()
            .filter_map(|(index, token)| {
                matches!(token.kind, TokenKind::RightParen).then_some(index)
            })
            .collect::<Vec<_>>();
        assert_eq!(paired_token(&parens, open_parens[0]), Some(close_parens[1]));
        assert_eq!(paired_token(&parens, open_parens[1]), Some(close_parens[0]));
    }

    #[test]
    fn index_preserves_alias_local_and_multiline_invocation_semantics() {
        let main = r#"include { CHILD as RENAMED } from './child'
include { utility } from 'plugin/example'

process LOCAL {
    script:
    """
    RENAMED()
    process PHANTOM {}
    """
}

workflow FLOW {
    main:
    RENAMED(
        'value\'s'
    )
    LOCAL()
    object.LOCAL()
    utility()
    missing()
}

workflow {
    FLOW()
}
"#;
        let child = "process CHILD_PROCESS { }\nworkflow CHILD {\n    CHILD_PROCESS()\n}\n";
        let files = vec![
            tracked_file("main.nf", main),
            tracked_file("child.nf", child),
        ];
        let mut budget = DerivedProjectionBudget::new();
        let indexed = index_nextflow(
            &files,
            "main.nf",
            "blake3:0000000000000000000000000000000000000000000000000000000000000000",
            &mut budget,
        )
        .expect("bounded source outline");

        let scopes = indexed
            .scopes
            .iter()
            .map(|scope| {
                (
                    scope.span.path.as_str(),
                    scope.span.start_line,
                    scope.span.end_line,
                    scope.kind,
                    scope.symbol.as_deref(),
                )
            })
            .collect::<Vec<_>>();
        assert_eq!(
            scopes,
            [
                (
                    "child.nf",
                    1,
                    1,
                    SourceScopeKind::Process,
                    Some("CHILD_PROCESS")
                ),
                ("child.nf", 2, 4, SourceScopeKind::Workflow, Some("CHILD")),
                ("main.nf", 4, 10, SourceScopeKind::Process, Some("LOCAL")),
                ("main.nf", 12, 21, SourceScopeKind::Workflow, Some("FLOW")),
                ("main.nf", 23, 25, SourceScopeKind::EntryWorkflow, None),
            ]
        );

        let invocations = indexed
            .invocations
            .iter()
            .map(|invocation| {
                (
                    invocation.name.as_str(),
                    invocation.span.path.as_str(),
                    invocation.span.start_line,
                    invocation.span.end_line,
                    invocation.callee.is_some(),
                )
            })
            .collect::<Vec<_>>();
        assert_eq!(
            invocations,
            [
                ("CHILD_PROCESS", "child.nf", 3, 3, true),
                ("RENAMED", "main.nf", 14, 16, true),
                ("LOCAL", "main.nf", 17, 17, true),
                ("utility", "main.nf", 19, 19, false),
                ("FLOW", "main.nf", 24, 24, true),
            ]
        );
        assert_eq!(indexed.diagnostics.len(), 1);
        assert_eq!(indexed.diagnostics[0].code, "source_only_invocation");
        assert!(indexed
            .invocations
            .iter()
            .all(|invocation| invocation.id.starts_with("invocation:")));
        assert!(indexed
            .scopes
            .iter()
            .all(|scope| scope.id.starts_with("scope:")));
    }

    #[test]
    fn source_outline_cardinality_is_bounded_before_projection_growth() {
        let digest = "blake3:0000000000000000000000000000000000000000000000000000000000000000";
        let base_limits = IndexLimits {
            tokens: 1_000,
            scopes: 100,
            includes: 100,
            invocations: 100,
            diagnostics: 100,
        };

        let mut token_budget = DerivedProjectionBudget::new();
        let token_error = index_nextflow_with_limits(
            &[tracked_file("main.nf", "process A {}")],
            "main.nf",
            digest,
            &mut token_budget,
            IndexLimits {
                tokens: 1,
                ..base_limits
            },
        );
        assert!(matches!(
            token_error,
            Err(SourceWorkflowError::SourceTooLarge(detail)) if detail.contains("tokens")
        ));

        let mut scope_budget = DerivedProjectionBudget::new();
        let scope_error = index_nextflow_with_limits(
            &[tracked_file("main.nf", "process A {}\nprocess B {}")],
            "main.nf",
            digest,
            &mut scope_budget,
            IndexLimits {
                scopes: 1,
                ..base_limits
            },
        );
        assert!(matches!(
            scope_error,
            Err(SourceWorkflowError::SourceTooLarge(detail)) if detail.contains("scopes")
        ));

        let mut include_budget = DerivedProjectionBudget::new();
        let include_error = index_nextflow_with_limits(
            &[
                tracked_file("main.nf", "include { A; B } from './child'"),
                tracked_file("child.nf", "process A {}\nprocess B {}"),
            ],
            "main.nf",
            digest,
            &mut include_budget,
            IndexLimits {
                includes: 1,
                ..base_limits
            },
        );
        assert!(matches!(
            include_error,
            Err(SourceWorkflowError::SourceTooLarge(detail)) if detail.contains("include bindings")
        ));

        let mut invocation_budget = DerivedProjectionBudget::new();
        let invocation_error = index_nextflow_with_limits(
            &[tracked_file(
                "main.nf",
                "process A {}\nworkflow W { A(); A() }",
            )],
            "main.nf",
            digest,
            &mut invocation_budget,
            IndexLimits {
                invocations: 1,
                ..base_limits
            },
        );
        assert!(matches!(
            invocation_error,
            Err(SourceWorkflowError::SourceTooLarge(detail)) if detail.contains("invocations")
        ));

        let non_utf8 = TrackedSourceFile {
            manifest: SourceFileManifest {
                path: "main.nf".to_owned(),
                mode: 0o100644,
                bytes: 1,
                digest: format!("blake3:{}", blake3::hash(&[0xff]).to_hex()),
            },
            bytes: vec![0xff].into(),
        };
        let mut diagnostic_budget = DerivedProjectionBudget::new();
        let diagnostic_error = index_nextflow_with_limits(
            &[non_utf8],
            "main.nf",
            digest,
            &mut diagnostic_budget,
            IndexLimits {
                diagnostics: 0,
                ..base_limits
            },
        );
        assert!(matches!(
            diagnostic_error,
            Err(SourceWorkflowError::SourceTooLarge(detail)) if detail.contains("diagnostics")
        ));
    }

    #[test]
    fn production_scope_limit_rejects_declaration_amplification() {
        use std::fmt::Write as _;

        let mut source = String::new();
        for index in 0..=super::MAX_INDEXED_SCOPES {
            writeln!(source, "process P{index} {{}}").expect("in-memory source");
        }
        let mut budget = DerivedProjectionBudget::new();
        let error = index_nextflow(
            &[tracked_file("main.nf", &source)],
            "main.nf",
            "blake3:0000000000000000000000000000000000000000000000000000000000000000",
            &mut budget,
        );
        assert!(matches!(
            error,
            Err(SourceWorkflowError::SourceTooLarge(detail)) if detail.contains("scopes")
        ));
    }

    #[test]
    fn nested_workflows_are_indexed_once_by_innermost_scope() {
        use std::fmt::Write as _;

        let mut source = String::from("process TARGET {}\n");
        for index in 0..100 {
            writeln!(source, "workflow W{index} {{").expect("in-memory source");
        }
        source.push_str("TARGET()\n");
        for _ in 0..100 {
            source.push_str("}\n");
        }

        let mut budget = DerivedProjectionBudget::new();
        let indexed = index_nextflow(
            &[tracked_file("main.nf", &source)],
            "main.nf",
            "blake3:0000000000000000000000000000000000000000000000000000000000000000",
            &mut budget,
        )
        .expect("linear nested outline");

        assert_eq!(indexed.invocations.len(), 1);
        let innermost = indexed
            .scopes
            .iter()
            .find(|scope| scope.symbol.as_deref() == Some("W99"))
            .expect("innermost workflow");
        assert_eq!(indexed.invocations[0].caller, innermost.id);
    }

    #[test]
    fn overlong_identifiers_fail_before_projection() {
        let source = format!(
            "process {} {{}}",
            "A".repeat(MAX_INDEXED_IDENTIFIER_BYTES + 1)
        );
        let mut budget = DerivedProjectionBudget::new();
        let error = index_nextflow(
            &[tracked_file("main.nf", &source)],
            "main.nf",
            "blake3:0000000000000000000000000000000000000000000000000000000000000000",
            &mut budget,
        );
        assert!(matches!(
            error,
            Err(SourceWorkflowError::SourceTooLarge(detail)) if detail.contains("identifier")
        ));
    }

    fn tracked_file(path: &str, source: &str) -> TrackedSourceFile<'static> {
        TrackedSourceFile {
            manifest: SourceFileManifest {
                path: path.to_owned(),
                mode: 0o100644,
                bytes: source.len() as u64,
                digest: format!("blake3:{}", blake3::hash(source.as_bytes()).to_hex()),
            },
            bytes: source.as_bytes().to_vec().into(),
        }
    }
}
