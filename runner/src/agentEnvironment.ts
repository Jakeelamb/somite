export const AGENT_CREDENTIAL_ENV_NAMES = "SOMITE_AGENT_CREDENTIAL_ENV_NAMES";

/**
 * Portable process-discovery, home/config, temporary-file, certificate,
 * locale, and platform values. Ambient application secrets are excluded.
 */
export const AGENT_SAFE_ENV_NAMES = [
  "PATH",
  "Path",
  "PATHEXT",
  "HOME",
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
  "APPDATA",
  "LOCALAPPDATA",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_CACHE_HOME",
  "XDG_STATE_HOME",
  "TMPDIR",
  "TMP",
  "TEMP",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "NODE_EXTRA_CA_CERTS",
  "NIX_SSL_CERT_FILE",
  "REQUESTS_CA_BUNDLE",
  "CURL_CA_BUNDLE",
  "GIT_SSL_CAINFO",
  "LANG",
  "LANGUAGE",
  "LC_ALL",
  "LC_CTYPE",
  "TZ",
  "SHELL",
  "USER",
  "LOGNAME",
  "USERNAME",
  "SYSTEMROOT",
  "SystemRoot",
  "WINDIR",
  "windir",
  "COMSPEC",
  "ComSpec",
  "OS",
  "PROCESSOR_ARCHITECTURE",
  "PROCESSOR_IDENTIFIER",
  "WSL_DISTRO_NAME",
  "WSL_INTEROP",
  "WSLENV",
] as const;

const NEVER_INHERIT = new Set([
  AGENT_CREDENTIAL_ENV_NAMES,
  "SOMITE_MCP_RUNTIME_CAPABILITY",
]);
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const CREDENTIAL_NAME = /(?:AUTH|CREDENTIAL|KEY|PASSWORD|SECRET|TOKEN)/i;
const MAX_CREDENTIAL_NAMES = 32;
const MAX_CREDENTIAL_CONFIG_BYTES = 4 * 1024;

function requestedCredentialNames(source: NodeJS.ProcessEnv) {
  const configured = source[AGENT_CREDENTIAL_ENV_NAMES]?.trim();
  if (!configured) return [];
  if (Buffer.byteLength(configured, "utf8") > MAX_CREDENTIAL_CONFIG_BYTES) {
    throw new Error(`${AGENT_CREDENTIAL_ENV_NAMES} exceeds ${MAX_CREDENTIAL_CONFIG_BYTES} bytes`);
  }
  const names = [...new Set(configured.split(",").map((name) => name.trim()).filter(Boolean))];
  if (names.length > MAX_CREDENTIAL_NAMES) throw new Error(`${AGENT_CREDENTIAL_ENV_NAMES} names more than ${MAX_CREDENTIAL_NAMES} variables`);
  for (const name of names) {
    if (NEVER_INHERIT.has(name)) throw new Error(`${name} may not be inherited by the Agent process`);
    if (!ENV_NAME.test(name) || !CREDENTIAL_NAME.test(name)) {
      throw new Error(`${AGENT_CREDENTIAL_ENV_NAMES} contains a non-credential environment name: ${name}`);
    }
  }
  return names;
}

/** Build the complete, explicit environment inherited by an ACP Agent child. */
export function agentChildEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const inherited: NodeJS.ProcessEnv = {};
  for (const name of AGENT_SAFE_ENV_NAMES) {
    const value = source[name];
    if (value !== undefined && !NEVER_INHERIT.has(name)) inherited[name] = value;
  }
  for (const name of requestedCredentialNames(source)) {
    const value = source[name];
    if (value !== undefined) inherited[name] = value;
  }
  return inherited;
}
