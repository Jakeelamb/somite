use std::collections::{BTreeMap, BTreeSet};

use regex::Regex;
use serde::de::{DeserializeSeed, MapAccess, SeqAccess, Visitor};
use serde::Deserialize;
use serde_json::{Map, Value};
use somite_ir::{
    ParamValue, SourceDiagnostic, SourceSpan, UnsupportedRequiredWorkflowParameter,
    WorkflowParameterField, WorkflowParameterType, MAX_EXACT_JSON_INTEGER,
    MAX_EXACT_JSON_INTEGER_BOUND, MIN_EXACT_JSON_INTEGER, MIN_EXACT_JSON_INTEGER_BOUND,
};

use crate::model::{digest, safe_relative_path, DerivedProjectionBudget, SourceWorkflowError};
use crate::source::TrackedSourceFile;

const MAX_PARAMETER_SCHEMA_BYTES: usize = 8 * 1024 * 1024;
const MAX_SCHEMA_NODES: usize = 100_000;
const MAX_SCHEMA_CONTAINER_ITEMS: usize = 20_000;
const MAX_SCHEMA_PARAMETERS: usize = 10_000;
const MAX_SCHEMA_STRING_BYTES: usize = 16 * 1024;
const MAX_SCHEMA_TOTAL_STRING_BYTES: usize = 16 * 1024 * 1024;

pub(crate) struct ParsedParameterSchema {
    pub fields: Vec<WorkflowParameterField>,
    pub unsupported_required: Vec<UnsupportedRequiredWorkflowParameter>,
    pub digest: Option<String>,
    pub diagnostics: Vec<SourceDiagnostic>,
    pub edits_supported: bool,
}

struct SchemaAccumulator {
    names: BTreeSet<String>,
    fields: Vec<WorkflowParameterField>,
    field_indices: BTreeMap<String, usize>,
    unsupported_required: Vec<UnsupportedRequiredWorkflowParameter>,
    unsupported_required_names: BTreeSet<String>,
    diagnostics: Vec<SourceDiagnostic>,
    edits_supported: bool,
}

struct UnsupportedProperty<'a> {
    detail: &'a str,
    code: &'a str,
}

struct RequiredNames {
    names: BTreeSet<String>,
    valid: bool,
}

/// Property keys whose validation or editing semantics are implemented below.
/// This is deliberately an allowlist: nf-schema extensions and future/custom
/// keywords remain source-only until Somite proves their behavior.
const PROPERTY_CONTRACT_KEYS: &[&str] = &[
    "type", "enum", "minimum", "maximum", "pattern", "format", "default",
];

/// Metadata which cannot change whether a property value is valid. In
/// particular, nf-schema's `mimetype` and `errorMessage` only affect
/// presentation; `exists`, `schema`, and `deprecated` are intentionally absent
/// because nf-schema gives them validation semantics.
const PROPERTY_ANNOTATION_KEYS: &[&str] = &[
    "title",
    "description",
    "help_text",
    "help",
    "hidden",
    "fa_icon",
    "mimetype",
    "errorMessage",
    "examples",
    "$comment",
    "readOnly",
    "writeOnly",
];

const CONTAINER_ANNOTATION_KEYS: &[&str] = &[
    "type",
    "title",
    "description",
    "help_text",
    "help",
    "hidden",
    "fa_icon",
    "default",
    "examples",
    "$comment",
    "readOnly",
    "writeOnly",
];

impl SchemaAccumulator {
    fn new() -> Self {
        Self {
            names: BTreeSet::new(),
            fields: Vec::new(),
            field_indices: BTreeMap::new(),
            unsupported_required: Vec::new(),
            unsupported_required_names: BTreeSet::new(),
            diagnostics: Vec::new(),
            edits_supported: true,
        }
    }

    fn push_field(&mut self, field: WorkflowParameterField) {
        let index = self.fields.len();
        self.field_indices.insert(field.name.clone(), index);
        self.fields.push(field);
    }

    fn mark_field_required(&mut self, name: &str) -> bool {
        let Some(index) = self.field_indices.get(name).copied() else {
            return false;
        };
        self.fields[index].required = true;
        true
    }

    fn push_unsupported_required(&mut self, parameter: UnsupportedRequiredWorkflowParameter) {
        if self
            .unsupported_required_names
            .insert(parameter.name.clone())
        {
            self.unsupported_required.push(parameter);
        }
    }
}

pub(crate) fn parse_parameter_schema(
    files: &[TrackedSourceFile<'_>],
    budget: &mut DerivedProjectionBudget,
) -> Result<ParsedParameterSchema, SourceWorkflowError> {
    let Some(schema_file) = files
        .iter()
        .find(|file| file.manifest.path == "nextflow_schema.json")
    else {
        budget.reserve(
            256 + "parameter_schema_missing".len()
                + "The pinned source has no tracked nextflow_schema.json.".len(),
            "parameter schema diagnostics",
        )?;
        return Ok(ParsedParameterSchema {
            fields: Vec::new(),
            unsupported_required: Vec::new(),
            digest: None,
            diagnostics: vec![SourceDiagnostic {
                code: "parameter_schema_missing".to_owned(),
                message: "The pinned source has no tracked nextflow_schema.json.".to_owned(),
                span: None,
            }],
            edits_supported: false,
        });
    };

    if schema_file.bytes.len() > MAX_PARAMETER_SCHEMA_BYTES {
        return Err(SourceWorkflowError::SourceTooLarge(format!(
            "nextflow_schema.json exceeds {MAX_PARAMETER_SCHEMA_BYTES} bytes"
        )));
    }

    let duplicate_keys = contains_duplicate_json_keys(&schema_file.bytes)?;
    let mut root: Value = serde_json::from_slice(&schema_file.bytes)?;
    // Duplicate members already make the entire editable contract ambiguous.
    // Avoid the stricter raw-struct precision pass in that case: Serde rejects
    // duplicate struct fields before Somite can retain the source-only schema.
    if !duplicate_keys {
        mark_precision_losing_properties(&schema_file.bytes, &mut root)?;
    }
    let shape = schema_projection_shape(&root)?;
    let projected_bytes = shape
        .nodes
        .checked_mul(256)
        .and_then(|bytes| {
            shape
                .string_bytes
                .checked_mul(6)
                .and_then(|strings| bytes.checked_add(strings))
        })
        .ok_or_else(|| {
            SourceWorkflowError::SourceTooLarge(
                "parameter schema projection byte count overflowed".to_owned(),
            )
        })?;
    budget.reserve(projected_bytes, "parameter schema projection")?;
    let mut parsed = SchemaAccumulator::new();
    if duplicate_keys {
        parsed.edits_supported = false;
        parsed.diagnostics.push(SourceDiagnostic {
            code: "unsupported_schema_container".to_owned(),
            message: "The parameter schema contains duplicate JSON object members; parameter editing is disabled because parser-independent semantics cannot be proven."
                .to_owned(),
            span: schema_span(),
        });
    }
    let definitions = root
        .get("$defs")
        .and_then(Value::as_object)
        .map(|definitions| ("$defs", definitions))
        .or_else(|| {
            root.get("definitions")
                .and_then(Value::as_object)
                .map(|definitions| ("definitions", definitions))
        });

    if let Some((namespace, definitions)) = definitions {
        for key in group_order(&root, namespace, definitions) {
            let Some(group) = definitions.get(&key).and_then(Value::as_object) else {
                parsed.edits_supported = false;
                parsed.diagnostics.push(SourceDiagnostic {
                    code: "unsupported_schema_container".to_owned(),
                    message: format!(
                        "Schema definition {key:?} is not an object; parameter editing is disabled."
                    ),
                    span: schema_span(),
                });
                continue;
            };
            append_group(&key, group, &mut parsed);
        }
    } else if let Some(properties) = root.get("properties").and_then(Value::as_object) {
        let required = required_names(root.as_object());
        if required.valid {
            append_properties("Parameters", properties, &required.names, &mut parsed);
        } else {
            refuse_container_contract(
                "Parameters",
                Some(properties),
                &required.names,
                "required must be an array of unique string names",
                &mut parsed,
            );
        }
    } else {
        parsed.edits_supported = false;
        parsed.diagnostics.push(SourceDiagnostic {
            code: "parameter_schema_empty".to_owned(),
            message: "nextflow_schema.json has no supported parameter properties.".to_owned(),
            span: schema_span(),
        });
    }

    if let Some(root) = root.as_object() {
        apply_root_constraints(root, definitions, &mut parsed);
    }

    Ok(ParsedParameterSchema {
        fields: parsed.fields,
        unsupported_required: parsed.unsupported_required,
        digest: Some(digest(&schema_file.bytes)),
        diagnostics: parsed.diagnostics,
        edits_supported: parsed.edits_supported,
    })
}

#[derive(Default)]
struct SchemaProjectionShape {
    nodes: usize,
    string_bytes: usize,
    parameters: usize,
}

fn schema_projection_shape(root: &Value) -> Result<SchemaProjectionShape, SourceWorkflowError> {
    let mut shape = SchemaProjectionShape::default();
    inspect_schema_value(root, &mut shape)?;
    Ok(shape)
}

fn inspect_schema_value(
    value: &Value,
    shape: &mut SchemaProjectionShape,
) -> Result<(), SourceWorkflowError> {
    shape.nodes = shape.nodes.checked_add(1).ok_or_else(|| {
        SourceWorkflowError::SourceTooLarge("parameter schema node count overflowed".to_owned())
    })?;
    if shape.nodes > MAX_SCHEMA_NODES {
        return Err(SourceWorkflowError::SourceTooLarge(format!(
            "parameter schema exceeds {MAX_SCHEMA_NODES} JSON nodes"
        )));
    }
    match value {
        Value::Object(object) => {
            if object.len() > MAX_SCHEMA_CONTAINER_ITEMS {
                return Err(SourceWorkflowError::SourceTooLarge(format!(
                    "parameter schema object exceeds {MAX_SCHEMA_CONTAINER_ITEMS} members"
                )));
            }
            for (key, child) in object {
                add_schema_string_bytes(shape, key)?;
                if key == "properties" {
                    if let Some(properties) = child.as_object() {
                        shape.parameters = shape
                            .parameters
                            .checked_add(properties.len())
                            .ok_or_else(|| {
                                SourceWorkflowError::SourceTooLarge(
                                    "parameter count overflowed".to_owned(),
                                )
                            })?;
                        if shape.parameters > MAX_SCHEMA_PARAMETERS {
                            return Err(SourceWorkflowError::SourceTooLarge(format!(
                                "parameter schema exceeds {MAX_SCHEMA_PARAMETERS} properties"
                            )));
                        }
                    }
                }
                inspect_schema_value(child, shape)?;
            }
        }
        Value::Array(values) => {
            if values.len() > MAX_SCHEMA_CONTAINER_ITEMS {
                return Err(SourceWorkflowError::SourceTooLarge(format!(
                    "parameter schema array exceeds {MAX_SCHEMA_CONTAINER_ITEMS} items"
                )));
            }
            for child in values {
                inspect_schema_value(child, shape)?;
            }
        }
        Value::String(value) => add_schema_string_bytes(shape, value)?,
        Value::Null | Value::Bool(_) | Value::Number(_) => {}
    }
    Ok(())
}

fn add_schema_string_bytes(
    shape: &mut SchemaProjectionShape,
    value: &str,
) -> Result<(), SourceWorkflowError> {
    if value.len() > MAX_SCHEMA_STRING_BYTES {
        return Err(SourceWorkflowError::SourceTooLarge(format!(
            "parameter schema string exceeds {MAX_SCHEMA_STRING_BYTES} bytes"
        )));
    }
    shape.string_bytes = shape.string_bytes.checked_add(value.len()).ok_or_else(|| {
        SourceWorkflowError::SourceTooLarge(
            "parameter schema string byte count overflowed".to_owned(),
        )
    })?;
    if shape.string_bytes > MAX_SCHEMA_TOTAL_STRING_BYTES {
        return Err(SourceWorkflowError::SourceTooLarge(format!(
            "parameter schema strings exceed {MAX_SCHEMA_TOTAL_STRING_BYTES} bytes"
        )));
    }
    Ok(())
}

fn group_order(root: &Value, namespace: &str, definitions: &Map<String, Value>) -> Vec<String> {
    let mut order = Vec::new();
    let mut seen = BTreeSet::new();
    if let Some(groups) = root.get("allOf").and_then(Value::as_array) {
        for group in groups {
            let Some(reference) = group.get("$ref").and_then(Value::as_str) else {
                continue;
            };
            let Some((reference_namespace, key)) = local_reference_key(reference) else {
                continue;
            };
            if reference_namespace == namespace
                && definitions.contains_key(&key)
                && seen.insert(key.clone())
            {
                order.push(key);
            }
        }
    }
    order
}

fn append_group(key: &str, group: &Map<String, Value>, parsed: &mut SchemaAccumulator) {
    let title = group
        .get("title")
        .and_then(Value::as_str)
        .filter(|title| admissible_display_text(title))
        .map(str::to_owned)
        .unwrap_or_else(|| {
            let fallback = human_label(key);
            if admissible_display_text(&fallback) {
                fallback
            } else {
                "Parameters".to_owned()
            }
        });
    let required = required_names(Some(group));
    let properties = group.get("properties").and_then(Value::as_object);
    if group.get("type").and_then(Value::as_str) != Some("object") {
        refuse_container_contract(
            &title,
            properties,
            &required.names,
            "container type must be object",
            parsed,
        );
        return;
    }
    if let Some(detail) = unsupported_container_constraint(group, &["properties", "required"]) {
        refuse_container_contract(&title, properties, &required.names, &detail, parsed);
        return;
    }
    let Some(properties) = properties else {
        if group.contains_key("properties") {
            parsed.edits_supported = false;
            parsed.diagnostics.push(SourceDiagnostic {
                code: "unsupported_schema_container".to_owned(),
                message: format!(
                    "Schema group {title} properties is not an object; parameter editing is disabled."
                ),
                span: schema_span(),
            });
        }
        if !required.valid {
            parsed.edits_supported = false;
            parsed.diagnostics.push(SourceDiagnostic {
                code: "unsupported_required_contract".to_owned(),
                message: format!(
                    "Schema group {title} has a malformed required contract; parameter editing is disabled."
                ),
                span: schema_span(),
            });
        }
        retain_missing_required(&title, &required.names, parsed);
        return;
    };
    if !required.valid {
        refuse_container_contract(
            &title,
            Some(properties),
            &required.names,
            "required must be an array of unique string names",
            parsed,
        );
        return;
    }
    append_properties(&title, properties, &required.names, parsed);
}

fn refuse_container_contract(
    group: &str,
    properties: Option<&Map<String, Value>>,
    required: &BTreeSet<String>,
    detail: &str,
    parsed: &mut SchemaAccumulator,
) {
    parsed.edits_supported = false;
    parsed.diagnostics.push(SourceDiagnostic {
        code: "unsupported_schema_container".to_owned(),
        message: format!(
            "Schema container {group} remains source-only because {detail}; parameter editing is disabled."
        ),
        span: schema_span(),
    });
    apply_required_names(group, required, properties, detail, parsed);
}

fn apply_required_names(
    group: &str,
    required: &BTreeSet<String>,
    properties: Option<&Map<String, Value>>,
    detail: &str,
    parsed: &mut SchemaAccumulator,
) {
    for name in required {
        if parsed.mark_field_required(name) {
            continue;
        }
        if parsed.unsupported_required_names.contains(name) {
            continue;
        }
        parsed.names.insert(name.clone());
        let schema = properties
            .and_then(|properties| properties.get(name))
            .and_then(Value::as_object);
        parsed.push_unsupported_required(UnsupportedRequiredWorkflowParameter {
            name: name.clone(),
            label: schema
                .and_then(|schema| schema.get("title"))
                .and_then(Value::as_str)
                .filter(|title| admissible_display_text(title))
                .map_or_else(|| human_label(name), str::to_owned),
            group: group.to_owned(),
            description: schema
                .and_then(|schema| schema.get("description"))
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned(),
            reason: detail.to_owned(),
            hidden: schema
                .and_then(|schema| schema.get("hidden"))
                .and_then(Value::as_bool)
                .unwrap_or(false),
        });
    }
}

fn apply_root_constraints(
    root: &Map<String, Value>,
    definitions: Option<(&str, &Map<String, Value>)>,
    parsed: &mut SchemaAccumulator,
) {
    if root.get("type").and_then(Value::as_str) != Some("object") {
        parsed.edits_supported = false;
        parsed.diagnostics.push(SourceDiagnostic {
            code: "unsupported_schema_container".to_owned(),
            message: "Root parameter schema type must be object; parameter editing is disabled."
                .to_owned(),
            span: schema_span(),
        });
    }

    let direct_required = required_names(Some(root));
    if !direct_required.valid {
        parsed.edits_supported = false;
        parsed.diagnostics.push(SourceDiagnostic {
            code: "unsupported_required_contract".to_owned(),
            message: "Root required must be an array of unique string names; parameter editing is disabled."
                .to_owned(),
            span: schema_span(),
        });
    }
    apply_required_names(
        "Parameters",
        &direct_required.names,
        root.get("properties").and_then(Value::as_object),
        "the root schema requires a parameter without one complete editable property contract",
        parsed,
    );

    if definitions.is_some() && root.get("properties").is_some() {
        parsed.edits_supported = false;
        parsed.diagnostics.push(SourceDiagnostic {
            code: "unsupported_schema_container".to_owned(),
            message: "Root properties combined with $defs/definitions are not a supported source-editor shape; parameter editing is disabled."
                .to_owned(),
            span: schema_span(),
        });
    }
    if root
        .get("properties")
        .is_some_and(|value| !value.is_object())
    {
        parsed.edits_supported = false;
        parsed.diagnostics.push(SourceDiagnostic {
            code: "unsupported_schema_container".to_owned(),
            message: "Root properties must be an object; parameter editing is disabled.".to_owned(),
            span: schema_span(),
        });
    }
    if root.contains_key("$defs") && root.contains_key("definitions") {
        parsed.edits_supported = false;
        parsed.diagnostics.push(SourceDiagnostic {
            code: "unsupported_schema_container".to_owned(),
            message: "Root schema cannot combine $defs and definitions in the typed source editor; parameter editing is disabled."
                .to_owned(),
            span: schema_span(),
        });
    }
    for keyword in ["$defs", "definitions"] {
        if root.get(keyword).is_some_and(|value| !value.is_object()) {
            parsed.edits_supported = false;
            parsed.diagnostics.push(SourceDiagnostic {
                code: "unsupported_schema_container".to_owned(),
                message: format!(
                    "Root {keyword} must be an object; parameter editing is disabled."
                ),
                span: schema_span(),
            });
        }
    }
    if let Some(detail) = unsupported_container_constraint(
        root,
        &[
            "properties",
            "required",
            "allOf",
            "$defs",
            "definitions",
            "$id",
            "$schema",
        ],
    ) {
        parsed.edits_supported = false;
        parsed.diagnostics.push(SourceDiagnostic {
            code: "unsupported_schema_container".to_owned(),
            message: format!("Root JSON Schema {detail}; parameter editing is disabled."),
            span: schema_span(),
        });
    }

    let Some(all_of) = root.get("allOf") else {
        if definitions.is_some_and(|(_, definitions)| !definitions.is_empty()) {
            parsed.edits_supported = false;
            parsed.diagnostics.push(SourceDiagnostic {
                code: "unsupported_schema_container".to_owned(),
                message: "Root definitions are not active parameters without explicit local allOf references; parameter editing is disabled."
                    .to_owned(),
                span: schema_span(),
            });
        }
        return;
    };
    let Some(clauses) = all_of.as_array() else {
        parsed.edits_supported = false;
        parsed.diagnostics.push(SourceDiagnostic {
            code: "unsupported_schema_container".to_owned(),
            message: "Root allOf must be an array; parameter editing is disabled.".to_owned(),
            span: schema_span(),
        });
        return;
    };
    for clause in clauses {
        let Some(clause) = clause.as_object() else {
            refuse_root_clause("allOf clause is not an object", parsed);
            continue;
        };
        if clause.len() == 1 {
            if let Some(reference) = clause.get("$ref").and_then(Value::as_str) {
                let target = local_reference_key(reference);
                if target.as_ref().is_some_and(|(namespace, key)| {
                    definitions.is_some_and(|(active_namespace, definitions)| {
                        namespace == &active_namespace && definitions.contains_key(key)
                    })
                }) {
                    continue;
                }
                refuse_root_clause("allOf contains an unknown or non-local $ref", parsed);
                continue;
            }
            if clause.contains_key("required") {
                let required = required_names(Some(clause));
                if !required.valid {
                    refuse_root_clause(
                        "allOf required must be an array of unique string names",
                        parsed,
                    );
                }
                apply_required_names(
                    "Parameters",
                    &required.names,
                    root.get("properties").and_then(Value::as_object),
                    "an allOf clause requires a parameter without one complete editable property contract",
                    parsed,
                );
                continue;
            }
        }
        refuse_root_clause("allOf clause contains unsupported assertions", parsed);
        let required = required_names(Some(clause));
        apply_required_names(
            "Parameters",
            &required.names,
            root.get("properties").and_then(Value::as_object),
            "an unsupported allOf clause contains this statically discoverable requirement",
            parsed,
        );
    }
}

fn refuse_root_clause(detail: &str, parsed: &mut SchemaAccumulator) {
    parsed.edits_supported = false;
    parsed.diagnostics.push(SourceDiagnostic {
        code: "unsupported_schema_container".to_owned(),
        message: format!("Root {detail}; parameter editing is disabled."),
        span: schema_span(),
    });
}

fn decode_reference_key(key: &str) -> Option<String> {
    let mut decoded = String::with_capacity(key.len());
    let mut characters = key.chars();
    while let Some(character) = characters.next() {
        if character != '~' {
            decoded.push(character);
            continue;
        }
        match characters.next() {
            Some('0') => decoded.push('~'),
            Some('1') => decoded.push('/'),
            _ => return None,
        }
    }
    Some(decoded)
}

fn local_reference_key(reference: &str) -> Option<(&'static str, String)> {
    let (namespace, key) = reference
        .strip_prefix("#/$defs/")
        .map(|key| ("$defs", key))
        .or_else(|| {
            reference
                .strip_prefix("#/definitions/")
                .map(|key| ("definitions", key))
        })?;
    (!key.contains('/') && !key.contains('%'))
        .then(|| decode_reference_key(key))
        .flatten()
        .map(|key| (namespace, key))
}

fn unsupported_container_constraint(
    schema: &Map<String, Value>,
    allowed: &[&str],
) -> Option<String> {
    if let Some(keyword) = schema
        .keys()
        .map(String::as_str)
        .find(|keyword| !allowed.contains(keyword) && !CONTAINER_ANNOTATION_KEYS.contains(keyword))
    {
        return Some(format!("container keyword {keyword:?} is not supported"));
    }
    malformed_annotation(schema, true)
        .map(|keyword| format!("container annotation {keyword} has an invalid value type"))
}

fn append_properties(
    group: &str,
    properties: &Map<String, Value>,
    required: &BTreeSet<String>,
    parsed: &mut SchemaAccumulator,
) {
    for (name, schema) in properties {
        if !admissible_parameter_name(name) {
            parsed.diagnostics.push(SourceDiagnostic {
                code: "unsupported_parameter_name".to_owned(),
                message: format!(
                    "Schema property name {name:?} remains source-only because editable parameter names must be non-blank and contain no control characters; independently proven parameters remain editable."
                ),
                span: schema_span(),
            });
            continue;
        }
        if !parsed.names.insert(name.clone()) {
            parsed.edits_supported = false;
            if required.contains(name)
                && !parsed.mark_field_required(name)
                && !parsed.unsupported_required_names.contains(name)
            {
                retain_unsupported_required(
                    name,
                    group,
                    schema.as_object(),
                    "duplicate parameter has no single representable contract",
                    required,
                    parsed,
                );
            }
            parsed.diagnostics.push(SourceDiagnostic {
                code: "duplicate_parameter".to_owned(),
                message: format!("Parameter {name} appears in more than one schema group."),
                span: schema_span(),
            });
            continue;
        }
        let Some(schema) = schema.as_object() else {
            let detail = "schema is not an object";
            retain_unsupported_required(name, group, None, detail, required, parsed);
            parsed.diagnostics.push(unsupported_parameter(name, detail));
            continue;
        };
        let Some(ty) = parameter_type(schema.get("type")) else {
            let detail = "type is not a supported primitive";
            retain_unsupported_required(name, group, Some(schema), detail, required, parsed);
            parsed.diagnostics.push(unsupported_parameter(name, detail));
            continue;
        };
        if let Some(detail) = unsupported_constraint(schema, ty) {
            retain_unsupported_property(
                name,
                group,
                schema,
                UnsupportedProperty {
                    detail: &detail,
                    code: "unsupported_parameter_constraint",
                },
                required,
                parsed,
            );
            continue;
        }
        let minimum = numeric_bound(schema.get("minimum"), ty);
        let maximum = numeric_bound(schema.get("maximum"), ty);
        let pattern = schema.get("pattern").and_then(Value::as_str);
        let compiled_pattern = match pattern {
            Some(pattern) => match compile_compatible_pattern(pattern) {
                Ok(compiled) => Some(compiled),
                Err(error) => {
                    let detail = format!(
                        "pattern is outside Somite's ECMA-262-compatible printable-ASCII subset ({error})"
                    );
                    retain_unsupported_required(
                        name,
                        group,
                        Some(schema),
                        &detail,
                        required,
                        parsed,
                    );
                    parsed.diagnostics.push(SourceDiagnostic {
                        code: "unsupported_parameter_pattern".to_owned(),
                        message: format!(
                            "Parameter {name} remains source-only because Somite cannot evaluate its JSON Schema pattern with proven ECMA-262 parity ({error}); independently proven parameters remain editable."
                        ),
                        span: schema_span(),
                    });
                    continue;
                }
            },
            None => None,
        };
        let choices = match schema.get("enum") {
            Some(Value::Array(values)) if !values.is_empty() => {
                let choices = values
                    .iter()
                    .filter_map(json_param_value)
                    .collect::<Vec<_>>();
                let path_contract =
                    schema
                        .get("format")
                        .and_then(Value::as_str)
                        .is_some_and(|format| {
                            matches!(format, "file-path" | "directory-path" | "path")
                        });
                let choices_valid = choices.len() == values.len()
                    && choices.iter().all(|value| {
                        value_valid(ty, value, minimum, maximum, &[])
                            && pattern_matches(compiled_pattern.as_ref(), value)
                    })
                    && (!path_contract
                        || choices.iter().all(|value| {
                            matches!(value, ParamValue::String(path) if safe_relative_path(path))
                        }));
                if !choices_valid {
                    retain_unsupported_property(
                        name,
                        group,
                        schema,
                        UnsupportedProperty {
                            detail: "enum contains a value outside the representable type, bounds, printable-ASCII pattern, or safe project-path domain",
                            code: "unsupported_parameter_enum",
                        },
                        required,
                        parsed,
                    );
                    continue;
                }
                choices
            }
            Some(Value::Array(_)) => {
                retain_unsupported_property(
                    name,
                    group,
                    schema,
                    UnsupportedProperty {
                        detail: "enum is empty and cannot produce an editable value",
                        code: "unsupported_parameter_enum",
                    },
                    required,
                    parsed,
                );
                continue;
            }
            Some(_) => {
                retain_unsupported_property(
                    name,
                    group,
                    schema,
                    UnsupportedProperty {
                        detail: "enum is not an array",
                        code: "unsupported_parameter_enum",
                    },
                    required,
                    parsed,
                );
                continue;
            }
            None => Vec::new(),
        };
        let default = schema
            .get("default")
            .and_then(json_param_value)
            .filter(|value| {
                value_valid(ty, value, minimum, maximum, &choices)
                    && pattern_matches(compiled_pattern.as_ref(), value)
                    && (!matches!(
                        schema.get("format").and_then(Value::as_str),
                        Some("file-path" | "directory-path" | "path")
                    ) || matches!(value, ParamValue::String(path) if safe_relative_path(path)))
            });
        if schema.get("default").is_some()
            && !schema.get("default").is_some_and(Value::is_null)
            && default.is_none()
        {
            retain_unsupported_property(
                name,
                group,
                schema,
                UnsupportedProperty {
                    detail: "default is outside the representable type, bounds, enum, or printable-ASCII pattern domain",
                    code: "unsupported_parameter_default",
                },
                required,
                parsed,
            );
            continue;
        }
        parsed.push_field(WorkflowParameterField {
            name: name.clone(),
            label: schema
                .get("title")
                .and_then(Value::as_str)
                .filter(|title| admissible_display_text(title))
                .map_or_else(|| human_label(name), str::to_owned),
            group: group.to_owned(),
            description: schema
                .get("description")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned(),
            help: schema
                .get("help_text")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned(),
            ty,
            required: required.contains(name),
            hidden: schema
                .get("hidden")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            managed: name == "outdir",
            format: schema
                .get("format")
                .and_then(Value::as_str)
                .map(str::to_owned),
            pattern: pattern.map(str::to_owned),
            default,
            choices,
            minimum,
            maximum,
        });
    }
    let missing = required
        .iter()
        .filter(|name| !properties.contains_key(*name))
        .cloned()
        .collect::<BTreeSet<_>>();
    retain_missing_required(group, &missing, parsed);
}

fn retain_unsupported_property(
    name: &str,
    group: &str,
    schema: &Map<String, Value>,
    issue: UnsupportedProperty<'_>,
    required: &BTreeSet<String>,
    parsed: &mut SchemaAccumulator,
) {
    retain_unsupported_required(name, group, Some(schema), issue.detail, required, parsed);
    parsed.diagnostics.push(SourceDiagnostic {
        code: issue.code.to_owned(),
        message: format!(
            "Parameter {name} remains source-only because its {}; independently proven parameters remain editable.",
            issue.detail
        ),
        span: schema_span(),
    });
}

fn unsupported_constraint(
    schema: &Map<String, Value>,
    ty: WorkflowParameterType,
) -> Option<String> {
    if schema.contains_key("x-somite-precision-loss") {
        return Some(
            "numeric constraint, default, or enum loses its original JSON decimal precision"
                .to_owned(),
        );
    }
    if let Some(keyword) = schema.keys().map(String::as_str).find(|keyword| {
        !PROPERTY_CONTRACT_KEYS.contains(keyword) && !PROPERTY_ANNOTATION_KEYS.contains(keyword)
    }) {
        return Some(format!(
            "property keyword {keyword:?} has no proven validation parity in the typed source editor"
        ));
    }
    if let Some(keyword) = malformed_annotation(schema, false) {
        return Some(format!("annotation {keyword} has an invalid value type"));
    }
    if schema
        .get("pattern")
        .is_some_and(|value| !value.is_string())
    {
        return Some("JSON Schema constraint pattern is not a string".to_owned());
    }
    if ["minimum", "maximum"]
        .into_iter()
        .any(|keyword| schema.contains_key(keyword))
        && !matches!(
            ty,
            WorkflowParameterType::Integer | WorkflowParameterType::Number
        )
    {
        return Some(
            "numeric bounds on a non-numeric property are outside Somite's proven editable contract"
                .to_owned(),
        );
    }
    for keyword in ["minimum", "maximum"] {
        if let Some(value) = schema.get(keyword) {
            if !value.is_number() {
                return Some(format!("JSON Schema constraint {keyword} is not a number"));
            }
            if ty == WorkflowParameterType::Integer
                && exact_json_integer_bound_value(value).is_none()
            {
                return Some(format!(
                    "integer constraint {keyword} is outside Somite's exact persisted-bound domain"
                ));
            }
            if ty == WorkflowParameterType::Number && exact_json_number_bound_value(value).is_none()
            {
                return Some(format!(
                    "number constraint {keyword} is outside Somite's proven persisted numeric-bound domain"
                ));
            }
        }
    }
    let minimum = numeric_bound(schema.get("minimum"), ty);
    let maximum = numeric_bound(schema.get("maximum"), ty);
    if matches!((minimum, maximum), (Some(minimum), Some(maximum)) if minimum > maximum) {
        return Some("minimum is greater than maximum".to_owned());
    }
    if let Some(format) = schema.get("format") {
        let supported = format
            .as_str()
            .is_some_and(|format| matches!(format, "file-path" | "directory-path" | "path"));
        if !supported || ty != WorkflowParameterType::String {
            return Some(
                "JSON Schema format is not a supported path format on a string property".to_owned(),
            );
        }
    }
    None
}

#[derive(Deserialize, Default)]
struct RawSchemaContainer {
    #[serde(default)]
    properties: Option<Box<serde_json::value::RawValue>>,
    #[serde(default, rename = "$defs")]
    defs: Option<Box<serde_json::value::RawValue>>,
    #[serde(default)]
    definitions: Option<Box<serde_json::value::RawValue>>,
}

#[derive(Deserialize, Default)]
struct RawNumericProperty {
    minimum: Option<Box<serde_json::value::RawValue>>,
    maximum: Option<Box<serde_json::value::RawValue>>,
    default: Option<Box<serde_json::value::RawValue>>,
    #[serde(rename = "enum")]
    choices: Option<Box<serde_json::value::RawValue>>,
}

struct DuplicateKeySeed;

impl<'de> DeserializeSeed<'de> for DuplicateKeySeed {
    type Value = bool;

    fn deserialize<D>(self, deserializer: D) -> Result<Self::Value, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        deserializer.deserialize_any(DuplicateKeyVisitor)
    }
}

struct DuplicateKeyVisitor;

impl<'de> Visitor<'de> for DuplicateKeyVisitor {
    type Value = bool;

    fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("a JSON value")
    }

    fn visit_map<M>(self, mut map: M) -> Result<Self::Value, M::Error>
    where
        M: MapAccess<'de>,
    {
        let mut names = BTreeSet::new();
        let mut duplicate = false;
        while let Some(name) = map.next_key::<String>()? {
            duplicate |= !names.insert(name);
            duplicate |= map.next_value_seed(DuplicateKeySeed)?;
        }
        Ok(duplicate)
    }

    fn visit_seq<S>(self, mut sequence: S) -> Result<Self::Value, S::Error>
    where
        S: SeqAccess<'de>,
    {
        let mut duplicate = false;
        while let Some(nested) = sequence.next_element_seed(DuplicateKeySeed)? {
            duplicate |= nested;
        }
        Ok(duplicate)
    }

    fn visit_bool<E>(self, _: bool) -> Result<Self::Value, E> {
        Ok(false)
    }

    fn visit_i64<E>(self, _: i64) -> Result<Self::Value, E> {
        Ok(false)
    }

    fn visit_u64<E>(self, _: u64) -> Result<Self::Value, E> {
        Ok(false)
    }

    fn visit_f64<E>(self, _: f64) -> Result<Self::Value, E> {
        Ok(false)
    }

    fn visit_str<E>(self, _: &str) -> Result<Self::Value, E> {
        Ok(false)
    }

    fn visit_string<E>(self, _: String) -> Result<Self::Value, E> {
        Ok(false)
    }

    fn visit_none<E>(self) -> Result<Self::Value, E> {
        Ok(false)
    }

    fn visit_unit<E>(self) -> Result<Self::Value, E> {
        Ok(false)
    }
}

fn contains_duplicate_json_keys(bytes: &[u8]) -> Result<bool, serde_json::Error> {
    let mut deserializer = serde_json::Deserializer::from_slice(bytes);
    let duplicate = DuplicateKeySeed.deserialize(&mut deserializer)?;
    deserializer.end()?;
    Ok(duplicate)
}

fn mark_precision_losing_properties(
    bytes: &[u8],
    root: &mut Value,
) -> Result<(), SourceWorkflowError> {
    let Ok(raw) = serde_json::from_slice::<RawSchemaContainer>(bytes) else {
        return Ok(());
    };
    if let Some(properties) = raw_object(raw.properties.as_deref()) {
        mark_raw_properties(&properties, root.get_mut("properties"));
    }
    for (namespace, definitions) in [("$defs", raw.defs), ("definitions", raw.definitions)] {
        let Some(definitions) = raw_object(definitions.as_deref()) else {
            continue;
        };
        for (key, definition) in definitions {
            let Ok(raw_group) = serde_json::from_str::<RawSchemaContainer>(definition.get()) else {
                continue;
            };
            let group = root
                .get_mut(namespace)
                .and_then(Value::as_object_mut)
                .and_then(|definitions| definitions.get_mut(&key))
                .and_then(Value::as_object_mut)
                .and_then(|group| group.get_mut("properties"));
            if let Some(properties) = raw_object(raw_group.properties.as_deref()) {
                mark_raw_properties(&properties, group);
            }
        }
    }
    Ok(())
}

fn raw_object(
    raw: Option<&serde_json::value::RawValue>,
) -> Option<std::collections::BTreeMap<String, Box<serde_json::value::RawValue>>> {
    serde_json::from_str(raw?.get()).ok()
}

fn mark_raw_properties(
    raw: &std::collections::BTreeMap<String, Box<serde_json::value::RawValue>>,
    properties: Option<&mut Value>,
) {
    let Some(properties) = properties.and_then(Value::as_object_mut) else {
        return;
    };
    for (name, property) in raw {
        if raw_property_loses_precision(property) {
            if let Some(property) = properties.get_mut(name).and_then(Value::as_object_mut) {
                property.insert("x-somite-precision-loss".to_owned(), Value::Bool(true));
            }
        }
    }
}

fn raw_property_loses_precision(property: &serde_json::value::RawValue) -> bool {
    let Ok(property) = serde_json::from_str::<RawNumericProperty>(property.get()) else {
        return true;
    };
    let direct = property
        .minimum
        .iter()
        .chain(property.maximum.iter())
        .chain(property.default.iter())
        .any(|value| raw_number_loses_precision(value.get()));
    let choices = property
        .choices
        .as_deref()
        .and_then(|choices| {
            serde_json::from_str::<Vec<Box<serde_json::value::RawValue>>>(choices.get()).ok()
        })
        .is_some_and(|choices| {
            choices
                .iter()
                .any(|value| raw_number_loses_precision(value.get()))
        });
    direct || choices
}

fn raw_number_loses_precision(value: &str) -> bool {
    if serde_json::from_str::<serde_json::Number>(value).is_err() {
        return false;
    }
    let Ok(parsed) = value.parse::<f64>() else {
        return true;
    };
    let Some(represented) = serde_json::Number::from_f64(parsed) else {
        return true;
    };
    normalize_decimal(value) != normalize_decimal(&represented.to_string())
}

fn malformed_annotation(schema: &Map<String, Value>, container: bool) -> Option<&str> {
    for keyword in [
        "title",
        "description",
        "help_text",
        "help",
        "fa_icon",
        "$comment",
    ] {
        if schema.get(keyword).is_some_and(|value| !value.is_string()) {
            return Some(keyword);
        }
    }
    for keyword in ["hidden", "readOnly", "writeOnly"] {
        if schema.get(keyword).is_some_and(|value| !value.is_boolean()) {
            return Some(keyword);
        }
    }
    if schema
        .get("examples")
        .is_some_and(|value| !value.is_array())
    {
        return Some("examples");
    }
    if !container {
        if schema
            .get("mimetype")
            .is_some_and(|value| !value.is_string())
        {
            return Some("mimetype");
        }
        if schema.get("errorMessage").is_some_and(|value| {
            !value.is_string()
                && !value
                    .as_object()
                    .is_some_and(|messages| messages.values().all(Value::is_string))
        }) {
            return Some("errorMessage");
        }
    }
    ["$id", "$schema"]
        .into_iter()
        .find(|keyword| schema.get(*keyword).is_some_and(|value| !value.is_string()))
}

fn retain_missing_required(
    group: &str,
    required: &BTreeSet<String>,
    parsed: &mut SchemaAccumulator,
) {
    for name in required {
        if !parsed.names.insert(name.clone()) {
            if !parsed.mark_field_required(name)
                && !parsed.unsupported_required_names.contains(name)
            {
                parsed.push_unsupported_required(UnsupportedRequiredWorkflowParameter {
                    name: name.clone(),
                    label: human_label(name),
                    group: group.to_owned(),
                    description: String::new(),
                    reason: "required name has no property contract".to_owned(),
                    hidden: false,
                });
            }
            continue;
        }
        let detail = "required name has no property contract";
        parsed.push_unsupported_required(UnsupportedRequiredWorkflowParameter {
            name: name.clone(),
            label: human_label(name),
            group: group.to_owned(),
            description: String::new(),
            reason: detail.to_owned(),
            hidden: false,
        });
        parsed.diagnostics.push(unsupported_parameter(name, detail));
    }
}

fn retain_unsupported_required(
    name: &str,
    group: &str,
    schema: Option<&Map<String, Value>>,
    detail: &str,
    required: &BTreeSet<String>,
    parsed: &mut SchemaAccumulator,
) {
    if !required.contains(name) {
        return;
    }
    parsed.push_unsupported_required(UnsupportedRequiredWorkflowParameter {
        name: name.to_owned(),
        label: schema
            .and_then(|schema| schema.get("title"))
            .and_then(Value::as_str)
            .filter(|title| admissible_display_text(title))
            .map_or_else(|| human_label(name), str::to_owned),
        group: group.to_owned(),
        description: schema
            .and_then(|schema| schema.get("description"))
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned(),
        reason: detail.to_owned(),
        hidden: schema
            .and_then(|schema| schema.get("hidden"))
            .and_then(Value::as_bool)
            .unwrap_or(false),
    });
}

fn pattern_matches(pattern: Option<&Regex>, value: &ParamValue) -> bool {
    match (pattern, value) {
        (Some(pattern), ParamValue::String(value)) => {
            compatible_pattern_input(value) && pattern.is_match(value)
        }
        _ => true,
    }
}

/// Compile only the regex language for which Rust `regex` and an ECMA-262
/// pattern have the same boolean match result over Somite's enforced input
/// domain: printable ASCII without line terminators or other controls.
///
/// The subset permits ASCII literals, ordinary groups (including `(?:...)`),
/// alternation, anchors, `.`, ASCII character classes/ranges, the common
/// character-class and boundary escapes, and `*`, `+`, and `?` quantifiers.
/// It rejects inline modes/lookarounds, backreferences, Unicode/hex escapes,
/// counted quantifiers, and Rust-only character-class set operations.
pub(crate) fn compile_compatible_pattern(pattern: &str) -> Result<Regex, String> {
    if !pattern.is_ascii() || pattern.bytes().any(|byte| byte.is_ascii_control()) {
        return Err("pattern source must be printable ASCII".to_owned());
    }
    if pattern.contains("&&")
        || pattern.contains("--")
        || pattern.contains("~~")
        || pattern.contains("[:")
        || pattern.contains(":]")
    {
        return Err(
            "character-class set operations and POSIX classes are not supported".to_owned(),
        );
    }

    let bytes = pattern.as_bytes();
    let mut index = 0;
    let mut in_class = false;
    while index < bytes.len() {
        match bytes[index] {
            b'\\' => {
                let Some(escaped) = bytes.get(index + 1).copied() else {
                    return Err("pattern ends with an incomplete escape".to_owned());
                };
                let shared_escape = if in_class {
                    matches!(
                        escaped,
                        b'd' | b'D' | b's' | b'S' | b'w' | b'W' | b']' | b'\\' | b'^' | b'-'
                    )
                } else {
                    matches!(
                        escaped,
                        b'd' | b'D'
                            | b's'
                            | b'S'
                            | b'w'
                            | b'W'
                            | b'b'
                            | b'B'
                            | b'.'
                            | b'^'
                            | b'$'
                            | b'*'
                            | b'+'
                            | b'?'
                            | b'('
                            | b')'
                            | b'['
                            | b']'
                            | b'|'
                            | b'\\'
                    )
                };
                if !shared_escape {
                    return Err(format!(
                        "escape \\{} is outside the supported subset",
                        escaped as char
                    ));
                }
                index += 2;
            }
            b'[' if in_class => {
                return Err("nested character classes are not supported".to_owned());
            }
            b'[' => {
                in_class = true;
                index += 1;
            }
            b']' if !in_class => {
                return Err("unmatched character-class close is not supported".to_owned());
            }
            b']' => {
                in_class = false;
                index += 1;
            }
            b'(' if !in_class && bytes.get(index + 1) == Some(&b'?') => {
                if bytes.get(index + 2) != Some(&b':') {
                    return Err(
                        "lookarounds, inline modes, and special groups are not supported"
                            .to_owned(),
                    );
                }
                index += 3;
            }
            b'{' | b'}' => {
                return Err("counted quantifiers are not supported".to_owned());
            }
            _ => index += 1,
        }
    }
    Regex::new(pattern).map_err(|error| error.to_string())
}

pub(crate) fn compatible_pattern_input(value: &str) -> bool {
    value.is_ascii() && !value.bytes().any(|byte| byte.is_ascii_control())
}

fn required_names(group: Option<&Map<String, Value>>) -> RequiredNames {
    let Some(value) = group.and_then(|group| group.get("required")) else {
        return RequiredNames {
            names: BTreeSet::new(),
            valid: true,
        };
    };
    let Some(values) = value.as_array() else {
        return RequiredNames {
            names: BTreeSet::new(),
            valid: false,
        };
    };
    let mut names = BTreeSet::new();
    let mut valid = true;
    for value in values {
        let Some(name) = value
            .as_str()
            .filter(|name| admissible_parameter_name(name))
        else {
            valid = false;
            continue;
        };
        valid &= names.insert(name.to_owned());
    }
    RequiredNames { names, valid }
}

fn admissible_parameter_name(name: &str) -> bool {
    !name.trim().is_empty() && !name.chars().any(char::is_control)
}

fn admissible_display_text(value: &str) -> bool {
    !value.trim().is_empty() && !value.chars().any(char::is_control)
}

fn parameter_type(value: Option<&Value>) -> Option<WorkflowParameterType> {
    match value.and_then(Value::as_str) {
        Some("string") => Some(WorkflowParameterType::String),
        Some("integer") => Some(WorkflowParameterType::Integer),
        Some("number") => Some(WorkflowParameterType::Number),
        Some("boolean") => Some(WorkflowParameterType::Boolean),
        _ => None,
    }
}

fn json_param_value(value: &Value) -> Option<ParamValue> {
    match value {
        Value::Bool(value) => Some(ParamValue::Bool(*value)),
        Value::Number(value) => value
            .as_i64()
            .map(ParamValue::Int)
            .or_else(|| exact_f64_value(value).and_then(ParamValue::from_f64)),
        Value::String(value) => Some(ParamValue::String(value.clone())),
        Value::Null | Value::Array(_) | Value::Object(_) => None,
    }
}

fn numeric_bound(value: Option<&Value>, ty: WorkflowParameterType) -> Option<f64> {
    value.and_then(|value| {
        let bound = if ty == WorkflowParameterType::Integer {
            exact_json_integer_bound_value(value).map(|value| value as f64)
        } else {
            exact_json_number_bound_value(value)
        }?;
        Some(if bound == 0.0 { 0.0 } else { bound })
    })
}

fn exact_json_integer_bound_value(value: &Value) -> Option<i64> {
    value.as_i64().filter(|value| {
        (MIN_EXACT_JSON_INTEGER_BOUND..=MAX_EXACT_JSON_INTEGER_BOUND).contains(value)
    })
}

fn exact_json_number_bound_value(value: &Value) -> Option<f64> {
    exact_f64_value(value.as_number()?).filter(|value| {
        value.is_finite()
            && *value >= MIN_EXACT_JSON_INTEGER_BOUND as f64
            && *value <= MAX_EXACT_JSON_INTEGER_BOUND as f64
    })
}

fn exact_f64_value(value: &serde_json::Number) -> Option<f64> {
    let source = value.to_string();
    let parsed = source
        .parse::<f64>()
        .ok()
        .filter(|value| value.is_finite())?;
    let represented = serde_json::Number::from_f64(parsed)?.to_string();
    (normalize_decimal(&source)? == normalize_decimal(&represented)?).then_some(parsed)
}

fn normalize_decimal(value: &str) -> Option<(bool, String, i64)> {
    let (negative, unsigned) = value
        .strip_prefix('-')
        .map_or((false, value), |unsigned| (true, unsigned));
    let (mantissa, exponent) = unsigned.split_once(['e', 'E']).map_or(
        Some((unsigned, 0_i64)),
        |(mantissa, exponent)| {
            exponent
                .parse::<i64>()
                .ok()
                .map(|exponent| (mantissa, exponent))
        },
    )?;
    let (whole, fraction) = mantissa.split_once('.').unwrap_or((mantissa, ""));
    let mut digits = String::with_capacity(whole.len() + fraction.len());
    digits.push_str(whole);
    digits.push_str(fraction);
    if !digits.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    let first_nonzero = digits.find(|character| character != '0');
    let Some(first_nonzero) = first_nonzero else {
        return Some((false, "0".to_owned(), 0));
    };
    digits.drain(..first_nonzero);
    let fraction_len = i64::try_from(fraction.len()).ok()?;
    let mut exponent = exponent.checked_sub(fraction_len)?;
    let trailing_zeros = digits
        .bytes()
        .rev()
        .take_while(|byte| *byte == b'0')
        .count();
    digits.truncate(digits.len() - trailing_zeros);
    exponent = exponent.checked_add(i64::try_from(trailing_zeros).ok()?)?;
    Some((negative, digits, exponent))
}

pub(crate) fn value_valid(
    ty: WorkflowParameterType,
    value: &ParamValue,
    minimum: Option<f64>,
    maximum: Option<f64>,
    choices: &[ParamValue],
) -> bool {
    if !value.is_json_transport_stable() {
        return false;
    }
    let type_matches = matches!(
        (ty, value),
        (WorkflowParameterType::String, ParamValue::String(_))
            | (WorkflowParameterType::Integer, ParamValue::Int(_))
            | (
                WorkflowParameterType::Number,
                ParamValue::Int(_) | ParamValue::Float(_)
            )
            | (WorkflowParameterType::Boolean, ParamValue::Bool(_))
    );
    if !type_matches
        || (!choices.is_empty() && !choices.iter().any(|choice| choice.schema_equal(value)))
    {
        return false;
    }
    if matches!(value, ParamValue::Int(value) if !(MIN_EXACT_JSON_INTEGER..=MAX_EXACT_JSON_INTEGER).contains(value))
    {
        return false;
    }
    if ty == WorkflowParameterType::Integer {
        let ParamValue::Int(value) = value else {
            return false;
        };
        return minimum.is_none_or(|minimum| *value >= minimum as i64)
            && maximum.is_none_or(|maximum| *value <= maximum as i64);
    }
    let number = match value {
        ParamValue::Int(value) => Some(*value as f64),
        ParamValue::Float(value) => Some(*value),
        ParamValue::Bool(_) | ParamValue::String(_) => None,
    };
    !number.is_some_and(|number| {
        !number.is_finite()
            || minimum.is_some_and(|minimum| number < minimum)
            || maximum.is_some_and(|maximum| number > maximum)
    })
}

fn unsupported_parameter(name: &str, detail: &str) -> SourceDiagnostic {
    SourceDiagnostic {
        code: "unsupported_parameter".to_owned(),
        message: format!("Parameter {name} remains source-only because its {detail}."),
        span: schema_span(),
    }
}

fn schema_span() -> Option<SourceSpan> {
    Some(SourceSpan {
        path: "nextflow_schema.json".to_owned(),
        start_line: 1,
        end_line: 1,
    })
}

fn human_label(name: &str) -> String {
    let label = name.replace('_', " ");
    let mut characters = label.chars();
    match characters.next() {
        Some(first) => first.to_uppercase().chain(characters).collect(),
        None => String::new(),
    }
}

#[cfg(test)]
mod tests {
    use serde_json::{json, Value};
    use somite_ir::ParamValue;

    use super::{
        compatible_pattern_input, compile_compatible_pattern, group_order, parse_parameter_schema,
        schema_projection_shape, ParsedParameterSchema, MAX_SCHEMA_CONTAINER_ITEMS,
        MAX_SCHEMA_PARAMETERS, MAX_SCHEMA_STRING_BYTES,
    };
    use crate::model::{digest, DerivedProjectionBudget, SourceFileManifest};
    use crate::source::TrackedSourceFile;

    fn parse_schema(schema: Value) -> ParsedParameterSchema {
        let bytes = serde_json::to_vec(&schema).expect("schema JSON");
        parse_schema_bytes(bytes)
    }

    fn parse_schema_bytes(bytes: Vec<u8>) -> ParsedParameterSchema {
        let mut budget = DerivedProjectionBudget::new();
        parse_parameter_schema(
            &[TrackedSourceFile {
                manifest: SourceFileManifest {
                    path: "nextflow_schema.json".to_owned(),
                    mode: 0o100644,
                    bytes: bytes.len() as u64,
                    digest: digest(&bytes),
                },
                bytes: bytes.into(),
            }],
            &mut budget,
        )
        .expect("parsed schema")
    }

    fn parse_property(property: Value) -> ParsedParameterSchema {
        parse_schema(json!({
            "type": "object",
            "required": ["input"],
            "properties": {"input": property}
        }))
    }

    fn parse_property_json(property: &str) -> ParsedParameterSchema {
        parse_schema_bytes(
            format!(
                r#"{{"type":"object","required":["input"],"properties":{{"input":{property}}}}}"#
            )
            .into_bytes(),
        )
    }

    #[test]
    fn compatible_pattern_subset_accepts_common_ascii_schema_patterns() {
        let pattern =
            compile_compatible_pattern(r"^\S+\.fn?a(sta)?(\.gz)?$").expect("common FASTA pattern");
        assert!(pattern.is_match("data/genome.fasta.gz"));
        assert!(!pattern.is_match("data/genome.fastq.gz"));
        assert!(compatible_pattern_input("data/genome.fasta.gz"));
    }

    #[test]
    fn compatible_pattern_subset_rejects_unproven_cross_engine_constructs() {
        for pattern in [
            r"^(?=genome).+\.fa$",
            r"(?i)^genome$",
            r"^\p{Letter}+$",
            r"^[a-z&&[^q]]+$",
            r"^[[a]]$",
            r"^a{2,4}$",
            "^génome$",
        ] {
            assert!(
                compile_compatible_pattern(pattern).is_err(),
                "{pattern:?} must fail closed"
            );
        }
        assert!(!compatible_pattern_input("génome.fa"));
        assert!(!compatible_pattern_input("genome.fa\n"));
    }

    #[test]
    fn unsupported_validation_keywords_never_become_editable_contracts() {
        for (keyword, value, ty) in [
            ("exclusiveMinimum", json!(0), "number"),
            ("minLength", json!(1), "string"),
            ("maxLength", json!(20), "string"),
            ("multipleOf", json!(2), "integer"),
            ("const", json!("genome.fa"), "string"),
        ] {
            let mut property = json!({"type": ty});
            property[keyword] = value;
            let parsed = parse_property(property);
            assert!(parsed.fields.is_empty(), "{keyword} must not be ignored");
            assert_eq!(parsed.unsupported_required.len(), 1);
            assert!(parsed.edits_supported);
            assert!(parsed
                .diagnostics
                .iter()
                .any(|diagnostic| diagnostic.code == "unsupported_parameter_constraint"));
        }
    }

    #[test]
    fn harmless_annotations_remain_distinct_from_unsupported_constraints() {
        let parsed = parse_property(json!({
            "type": "string",
            "title": "Input",
            "description": "Input file",
            "help_text": "Choose a FASTA",
            "fa_icon": "fas fa-file",
            "mimetype": "text/csv",
            "errorMessage": "Choose a valid input",
            "examples": ["genome.fa"],
            "readOnly": false,
            "writeOnly": false,
            "$comment": "display metadata"
        }));
        assert_eq!(parsed.fields.len(), 1);
        assert!(parsed.unsupported_required.is_empty());
        assert!(parsed.edits_supported);
    }

    #[test]
    fn malformed_property_annotations_are_property_local_source_only() {
        for (keyword, value) in [
            ("title", json!(7)),
            ("hidden", json!("yes")),
            ("examples", json!({"input": "genome.fa"})),
            ("readOnly", json!("false")),
        ] {
            let mut property = json!({"type": "string"});
            property[keyword] = value;
            let parsed = parse_property(property);
            assert!(parsed.fields.is_empty(), "{keyword} must fail closed");
            assert_eq!(parsed.unsupported_required.len(), 1);
            assert!(parsed.edits_supported, "{keyword} is property-local");
            assert!(parsed.diagnostics.iter().any(|diagnostic| {
                diagnostic.code == "unsupported_parameter_constraint"
                    && diagnostic.message.contains(keyword)
            }));
        }
    }

    #[test]
    fn inadmissible_optional_property_names_stay_source_only() {
        let parsed = parse_schema(json!({
            "type": "object",
            "properties": {
                "": {"type": "string"},
                "bad\nname": {"type": "string"},
                "good": {"type": "string"}
            }
        }));
        assert!(parsed.edits_supported, "{:#?}", parsed.diagnostics);
        assert_eq!(parsed.fields.len(), 1);
        assert_eq!(parsed.fields[0].name, "good");
        assert!(parsed.unsupported_required.is_empty());
        assert_eq!(
            parsed
                .diagnostics
                .iter()
                .filter(|diagnostic| diagnostic.code == "unsupported_parameter_name")
                .count(),
            2
        );
    }

    #[test]
    fn schema_projection_shape_rejects_string_container_and_parameter_amplification() {
        let string_error =
            schema_projection_shape(&Value::String("x".repeat(MAX_SCHEMA_STRING_BYTES + 1)));
        assert!(matches!(
            string_error,
            Err(crate::model::SourceWorkflowError::SourceTooLarge(detail))
                if detail.contains("string")
        ));

        let container_error = schema_projection_shape(&Value::Array(vec![
            Value::Null;
            MAX_SCHEMA_CONTAINER_ITEMS
                + 1
        ]));
        assert!(matches!(
            container_error,
            Err(crate::model::SourceWorkflowError::SourceTooLarge(detail))
                if detail.contains("array")
        ));

        let mut properties = serde_json::Map::new();
        for index in 0..=MAX_SCHEMA_PARAMETERS {
            properties.insert(format!("p{index}"), json!({"type": "string"}));
        }
        let parameter_error = schema_projection_shape(&json!({
            "properties": Value::Object(properties)
        }));
        assert!(matches!(
            parameter_error,
            Err(crate::model::SourceWorkflowError::SourceTooLarge(detail))
                if detail.contains("properties")
        ));
    }

    #[test]
    fn active_group_order_is_bounded_at_the_schema_container_limit() {
        let mut definitions = serde_json::Map::new();
        let mut clauses = Vec::with_capacity(MAX_SCHEMA_CONTAINER_ITEMS);
        for index in 0..MAX_SCHEMA_CONTAINER_ITEMS {
            let key = format!("group_{index}");
            definitions.insert(key.clone(), Value::Object(serde_json::Map::new()));
            clauses.push(json!({"$ref": format!("#/$defs/{key}")}));
        }
        let root = json!({"allOf": clauses});
        let ordered = group_order(&root, "$defs", &definitions);
        assert_eq!(ordered.len(), MAX_SCHEMA_CONTAINER_ITEMS);
        assert_eq!(ordered.first().map(String::as_str), Some("group_0"));
        assert_eq!(
            ordered.last().map(String::as_str),
            Some(format!("group_{}", MAX_SCHEMA_CONTAINER_ITEMS - 1).as_str())
        );
    }

    #[test]
    fn malformed_container_annotations_lock_the_schema() {
        for schema in [
            json!({
                "type": "object",
                "title": 7,
                "properties": {"input": {"type": "string"}}
            }),
            json!({
                "type": "object",
                "$defs": {
                    "io": {
                        "type": "object",
                        "hidden": "yes",
                        "properties": {"input": {"type": "string"}}
                    }
                },
                "allOf": [{"$ref": "#/$defs/io"}]
            }),
        ] {
            let parsed = parse_schema(schema);
            assert!(!parsed.edits_supported);
            assert!(parsed
                .diagnostics
                .iter()
                .any(|diagnostic| diagnostic.code == "unsupported_schema_container"));
        }
    }

    #[test]
    fn duplicate_json_members_lock_the_schema_before_last_wins_parsing() {
        for schema in [
            br#"{"type":"object","type":"object","properties":{"input":{"type":"string"}}}"#.as_slice(),
            br#"{"type":"object","properties":{"input":{"type":"string","type":"integer"}}}"#.as_slice(),
            br#"{"type":"object","properties":{"input":{"type":"string"},"input":{"type":"integer"}}}"#.as_slice(),
            br#"{"type":"object","properties":{},"properties":{"input":{"type":"string"}}}"#.as_slice(),
            br##"{"type":"object","$defs":{"io":{"type":"object","properties":{},"properties":{"input":{"type":"string"}}}},"allOf":[{"$ref":"#/$defs/io"}]}"##.as_slice(),
        ] {
            let parsed = parse_schema_bytes(schema.to_vec());
            assert!(!parsed.edits_supported);
            assert!(parsed.diagnostics.iter().any(|diagnostic| {
                diagnostic.code == "unsupported_schema_container"
                    && diagnostic.message.contains("duplicate JSON")
            }));
        }
    }

    #[test]
    fn integer_contracts_stay_inside_the_exact_json_domain() {
        let safe = parse_property(json!({
            "type": "integer",
            "minimum": -9007199254740990_i64,
            "maximum": 9007199254740990_i64,
            "enum": [-9007199254740990_i64, 0, 9007199254740990_i64],
            "default": 9007199254740990_i64
        }));
        assert_eq!(safe.fields.len(), 1);
        assert!(safe.edits_supported);
        let safe_values = parse_property(json!({
            "type": "integer",
            "enum": [-9007199254740991_i64, 9007199254740991_i64],
            "default": 9007199254740991_i64
        }));
        assert_eq!(safe_values.fields.len(), 1);
        assert!(safe_values.edits_supported);

        for (property, code) in [
            (
                json!({"type": "integer", "minimum": -9007199254740991_i64}),
                "unsupported_parameter_constraint",
            ),
            (
                json!({"type": "integer", "maximum": 9007199254740991_i64}),
                "unsupported_parameter_constraint",
            ),
            (
                json!({"type": "integer", "minimum": -9007199254740992_i64}),
                "unsupported_parameter_constraint",
            ),
            (
                json!({"type": "integer", "maximum": 9007199254740992_i64}),
                "unsupported_parameter_constraint",
            ),
            (
                json!({"type": "integer", "default": 9007199254740992_i64}),
                "unsupported_parameter_default",
            ),
            (
                json!({"type": "integer", "enum": [9007199254740991_i64, 9007199254740992_i64]}),
                "unsupported_parameter_enum",
            ),
            (
                json!({"type": "number", "minimum": 9007199254740993_i64}),
                "unsupported_parameter_constraint",
            ),
        ] {
            let parsed = parse_property(property);
            assert!(parsed.fields.is_empty());
            assert_eq!(parsed.unsupported_required.len(), 1);
            assert!(parsed.edits_supported);
            assert!(parsed
                .diagnostics
                .iter()
                .any(|diagnostic| diagnostic.code == code));
        }
    }

    #[test]
    fn precision_losing_fractional_numbers_remain_source_only() {
        let safe = parse_property_json(
            r#"{"type":"number","minimum":0.1,"maximum":1.5,"enum":[0.1,1.5],"default":0.1}"#,
        );
        assert_eq!(safe.fields.len(), 1);
        assert!(safe.edits_supported);

        for (property, code) in [
            (
                r#"{"type":"number","minimum":0.10000000000000001}"#,
                "unsupported_parameter_constraint",
            ),
            (
                r#"{"type":"number","default":0.10000000000000001}"#,
                "unsupported_parameter_constraint",
            ),
            (
                r#"{"type":"number","enum":[0.1,0.10000000000000001]}"#,
                "unsupported_parameter_constraint",
            ),
        ] {
            let parsed = parse_property_json(property);
            assert!(parsed.fields.is_empty());
            assert_eq!(parsed.unsupported_required.len(), 1);
            assert!(parsed.edits_supported);
            assert!(parsed
                .diagnostics
                .iter()
                .any(|diagnostic| diagnostic.code == code));
        }
    }

    #[test]
    fn integral_number_defaults_enums_and_signed_zero_bounds_are_canonicalized() {
        let parsed = parse_property_json(
            r#"{"type":"number","minimum":-0.0,"enum":[1.0,-0.0,0.25],"default":1.0}"#,
        );
        assert_eq!(parsed.fields.len(), 1, "{:#?}", parsed.diagnostics);
        let field = &parsed.fields[0];
        assert_eq!(field.default, Some(ParamValue::Int(1)));
        assert_eq!(
            field.choices,
            vec![
                ParamValue::Int(1),
                ParamValue::Int(0),
                ParamValue::Float(0.25)
            ]
        );
        let minimum = field.minimum.expect("canonical minimum");
        assert_eq!(minimum, 0.0);
        assert!(!minimum.is_sign_negative());
    }

    #[test]
    fn path_formats_on_non_string_properties_remain_source_only() {
        for ty in ["integer", "number", "boolean"] {
            let parsed = parse_property(json!({"type": ty, "format": "file-path"}));
            assert!(parsed.fields.is_empty());
            assert_eq!(parsed.unsupported_required.len(), 1);
            assert!(parsed.edits_supported);
            assert!(parsed.diagnostics.iter().any(|diagnostic| {
                diagnostic.code == "unsupported_parameter_constraint"
                    && diagnostic.message.contains("string property")
            }));
        }
    }

    #[test]
    fn unsafe_path_enum_choices_remain_source_only() {
        for choice in ["", "   ", "/tmp/input.fa", "../input.fa", "data\\input.fa"] {
            let parsed = parse_property(json!({
                "type": "string",
                "format": "file-path",
                "enum": [choice]
            }));
            assert!(parsed.fields.is_empty(), "unsafe choice {choice:?}");
            assert_eq!(parsed.unsupported_required.len(), 1);
            assert!(parsed.edits_supported);
            assert!(parsed.diagnostics.iter().any(|diagnostic| {
                diagnostic.code == "unsupported_parameter_enum"
                    && diagnostic.message.contains("source-only")
            }));

            let parsed_default = parse_property(json!({
                "type": "string",
                "format": "file-path",
                "default": choice
            }));
            assert!(
                parsed_default.fields.is_empty(),
                "unsafe default {choice:?}"
            );
            assert_eq!(parsed_default.unsupported_required.len(), 1);
            assert!(parsed_default.diagnostics.iter().any(|diagnostic| {
                diagnostic.code == "unsupported_parameter_default"
                    && diagnostic.message.contains("source-only")
            }));
        }

        let parsed = parse_property(json!({
            "type": "string",
            "format": "file-path",
            "enum": ["data/input.fa"]
        }));
        assert_eq!(parsed.fields.len(), 1);
        assert_eq!(
            parsed.fields[0].choices,
            vec![ParamValue::String("data/input.fa".to_owned())]
        );
    }

    #[test]
    fn nf_schema_validators_and_unknown_property_keywords_remain_source_only() {
        for (keyword, value) in [
            ("exists", json!(true)),
            ("schema", json!("assets/samplesheet_schema.json")),
            ("deprecated", json!(false)),
            ("futureConstraint", json!({"mode": "strict"})),
        ] {
            let mut property = json!({"type": "string"});
            property[keyword] = value;
            let parsed = parse_property(property);
            assert!(
                parsed.fields.is_empty(),
                "{keyword} must remain source-only"
            );
            assert_eq!(parsed.unsupported_required.len(), 1);
            assert!(parsed.edits_supported, "{keyword} is property-local");
            assert!(parsed.diagnostics.iter().any(|diagnostic| {
                diagnostic.code == "unsupported_parameter_constraint"
                    && diagnostic.message.contains(keyword)
            }));
        }
    }

    #[test]
    fn unsupported_properties_do_not_lock_independent_editable_contracts() {
        for required in [vec!["input"], vec!["input", "sample_overrides"]] {
            let parsed = parse_schema(json!({
                "type": "object",
                "required": required,
                "properties": {
                    "input": {"type": "string", "format": "file-path"},
                    "sample_overrides": {
                        "type": "string",
                        "schema": "assets/samplesheet_schema.json"
                    }
                }
            }));
            assert!(parsed.edits_supported);
            assert_eq!(parsed.fields.len(), 1);
            assert_eq!(parsed.fields[0].name, "input");
            let unsupported_is_required = required.contains(&"sample_overrides");
            assert_eq!(
                parsed.unsupported_required.len(),
                usize::from(unsupported_is_required)
            );
            assert!(parsed
                .diagnostics
                .iter()
                .any(|diagnostic| diagnostic.code == "unsupported_parameter_constraint"));
        }
    }

    #[test]
    fn valid_empty_parameter_schema_is_complete_and_editable() {
        let parsed = parse_schema(json!({
            "type": "object",
            "properties": {}
        }));
        assert!(parsed.fields.is_empty());
        assert!(parsed.unsupported_required.is_empty());
        assert!(parsed.edits_supported);
    }

    #[test]
    fn invalid_patterned_enum_and_default_are_retained_source_only() {
        for (property, code) in [
            (
                json!({
                    "type": "string",
                    "pattern": "^[A-Za-z.]+$",
                    "enum": ["genome.fa", "génome.fa"]
                }),
                "unsupported_parameter_enum",
            ),
            (
                json!({
                    "type": "string",
                    "pattern": "^.+[.]fa$",
                    "default": "genome.fastq"
                }),
                "unsupported_parameter_default",
            ),
        ] {
            let parsed = parse_property(property);
            assert!(parsed.fields.is_empty());
            assert_eq!(parsed.unsupported_required.len(), 1);
            assert!(parsed.edits_supported);
            assert!(parsed
                .diagnostics
                .iter()
                .any(|diagnostic| diagnostic.code == code));
        }
    }

    #[test]
    fn root_all_of_required_clause_updates_the_referenced_group_contract() {
        let parsed = parse_schema(json!({
            "type": "object",
            "$defs": {
                "io": {
                    "type": "object",
                    "properties": {"input": {"type": "string"}}
                }
            },
            "allOf": [
                {"$ref": "#/$defs/io"},
                {"required": ["input"]}
            ]
        }));
        assert!(parsed.edits_supported);
        assert!(parsed.unsupported_required.is_empty());
        assert_eq!(parsed.fields.len(), 1);
        assert!(parsed.fields[0].required);
    }

    #[test]
    fn active_groups_without_properties_still_validate_their_container_contract() {
        for schema in [
            json!({
                "type": "object",
                "$defs": {
                    "io": {
                        "type": "object",
                        "if": {},
                        "then": {"required": ["secret"]}
                    }
                },
                "allOf": [{"$ref": "#/$defs/io"}]
            }),
            json!({
                "type": "object",
                "$defs": {"io": {"type": "string"}},
                "allOf": [{"$ref": "#/$defs/io"}]
            }),
        ] {
            let parsed = parse_schema(schema);
            assert!(!parsed.edits_supported);
            assert!(parsed.fields.is_empty());
            assert!(parsed
                .diagnostics
                .iter()
                .any(|diagnostic| diagnostic.code == "unsupported_schema_container"));
        }

        let empty_group = parse_schema(json!({
            "type": "object",
            "$defs": {"io": {"type": "object"}},
            "allOf": [{"$ref": "#/$defs/io"}]
        }));
        assert!(
            empty_group.edits_supported,
            "{:#?}",
            empty_group.diagnostics
        );
        assert!(empty_group.fields.is_empty());
    }

    #[test]
    fn active_non_object_definition_names_are_debug_escaped_in_diagnostics() {
        let key = "hostile\n\u{7}group";
        let parsed = parse_schema(json!({
            "type": "object",
            "$defs": {key: "not an object"},
            "allOf": [{"$ref": format!("#/$defs/{key}")}]
        }));
        let diagnostic = parsed
            .diagnostics
            .iter()
            .find(|diagnostic| diagnostic.code == "unsupported_schema_container")
            .expect("active non-object definition diagnostic");

        assert!(
            !diagnostic.message.chars().any(char::is_control),
            "persisted diagnostic contains a raw control character: {:?}",
            diagnostic.message
        );
        assert!(
            diagnostic.message.contains(&format!("{key:?}")),
            "definition key is not debug escaped: {:?}",
            diagnostic.message
        );
    }

    #[test]
    fn invalid_json_pointer_escape_never_activates_a_definition() {
        for (key, reference) in [
            ("bad~2key", "#/$defs/bad~2key"),
            ("group/property", "#/$defs/group/property"),
            ("bad%2Fkey", "#/$defs/bad%2Fkey"),
            ("bad%7E2key", "#/$defs/bad%7E2key"),
        ] {
            let parsed = parse_schema(json!({
                "type": "object",
                "$defs": {
                    key: {
                        "type": "object",
                        "properties": {"input": {"type": "string"}}
                    }
                },
                "allOf": [{"$ref": reference}]
            }));
            assert!(!parsed.edits_supported);
            assert!(parsed.fields.is_empty());
            assert!(parsed
                .diagnostics
                .iter()
                .any(|diagnostic| diagnostic.code == "unsupported_schema_container"));
        }
    }

    #[test]
    fn local_references_must_target_the_declared_definition_namespace() {
        for schema in [
            json!({
                "type": "object",
                "$defs": {
                    "io": {
                        "type": "object",
                        "properties": {"input": {"type": "string"}}
                    }
                },
                "allOf": [{"$ref": "#/definitions/io"}]
            }),
            json!({
                "type": "object",
                "definitions": {
                    "io": {
                        "type": "object",
                        "properties": {"input": {"type": "string"}}
                    }
                },
                "allOf": [{"$ref": "#/$defs/io"}]
            }),
        ] {
            let parsed = parse_schema(schema);
            assert!(!parsed.edits_supported);
            assert!(parsed.fields.is_empty());
            assert!(parsed
                .diagnostics
                .iter()
                .any(|diagnostic| diagnostic.code == "unsupported_schema_container"));
        }
    }

    #[test]
    fn valid_json_pointer_escapes_resolve_within_the_same_namespace() {
        let parsed = parse_schema(json!({
            "type": "object",
            "$defs": {
                "group/name~suffix": {
                    "type": "object",
                    "properties": {"input": {"type": "string"}}
                }
            },
            "allOf": [{"$ref": "#/$defs/group~1name~0suffix"}]
        }));
        assert!(parsed.edits_supported, "{:#?}", parsed.diagnostics);
        assert_eq!(parsed.fields.len(), 1);
        assert_eq!(parsed.fields[0].name, "input");
    }

    #[test]
    fn malformed_required_refuses_the_contract_and_retains_known_names() {
        let parsed = parse_schema(json!({
            "type": "object",
            "$defs": {
                "io": {
                    "type": "object",
                    "required": ["input", 7],
                    "properties": {"input": {"type": "string"}}
                }
            },
            "allOf": [{"$ref": "#/$defs/io"}]
        }));
        assert!(!parsed.edits_supported);
        assert!(parsed.fields.is_empty());
        assert_eq!(parsed.unsupported_required.len(), 1);
        assert_eq!(parsed.unsupported_required[0].name, "input");
        assert!(parsed
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.code == "unsupported_schema_container"));
    }

    #[test]
    fn unsupported_root_and_group_assertions_disable_editing() {
        for schema in [
            json!({
                "type": "object",
                "properties": {"input": {"type": "string"}},
                "if": {"properties": {"mode": {"const": "strict"}}},
                "then": {"required": ["input"]}
            }),
            json!({
                "type": "object",
                "$defs": {
                    "io": {
                        "type": "object",
                        "required": ["input"],
                        "properties": {"input": {"type": "string"}},
                        "dependentRequired": {"input": ["reference"]}
                    }
                },
                "allOf": [{"$ref": "#/$defs/io"}]
            }),
            json!({
                "type": "object",
                "$defs": {
                    "io": {
                        "type": "object",
                        "properties": {
                            "a": {"type": "string"},
                            "b": {"type": "string"}
                        },
                        "dependencies": {"a": ["b"]}
                    }
                },
                "allOf": [{"$ref": "#/$defs/io"}]
            }),
            json!({
                "type": "object",
                "enum": [{}],
                "properties": {"input": {"type": "string"}}
            }),
            json!({
                "type": "object",
                "$defs": {
                    "io": {
                        "required": ["input"],
                        "properties": {"input": {"type": "string"}}
                    }
                },
                "allOf": [{"$ref": "#/$defs/io"}]
            }),
            json!({
                "type": "object",
                "$defs": {
                    "io": {
                        "type": "object",
                        "properties": {"input": {"type": "string"}},
                        "futureContainerConstraint": {"input": "coupled"}
                    }
                },
                "allOf": [{"$ref": "#/$defs/io"}]
            }),
        ] {
            let parsed = parse_schema(schema);
            assert!(!parsed.edits_supported);
            assert!(parsed
                .diagnostics
                .iter()
                .any(|diagnostic| diagnostic.code == "unsupported_schema_container"));
        }
    }

    #[test]
    fn unreferenced_definitions_never_create_phantom_parameters() {
        let parsed = parse_schema(json!({
            "type": "object",
            "$defs": {
                "inert": {
                    "type": "object",
                    "required": ["ghost"],
                    "properties": {"ghost": {"type": "string"}}
                }
            }
        }));
        assert!(parsed.fields.is_empty());
        assert!(parsed.unsupported_required.is_empty());
        assert!(!parsed.edits_supported);
        assert!(parsed
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.message.contains("not active parameters")));
    }
}
