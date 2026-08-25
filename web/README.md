# Axial Web

Browser client for Axial's Rust graph engine. The browser owns interaction and
presentation; `axial-server` owns project loading, operator discovery, graph
validation, saving, and file import.

Start both layers from the repository root:

```bash
scripts/axial-web
```

Then open <http://localhost:3000>. Pass a graph path as the first argument to
open a specific project graph.

## Verification

```bash
npm run typecheck
npm run lint
npm test
npx vinext check
```

The default launch graph lives at `.axial/web.axial.json` and is intentionally
ignored by Git. Browser file imports are copied into `.axial/uploads/`; the
source files selected by the user are not modified.

This is a local project client today. Cloud hosting cannot execute against a
user's local files or tools until Axial has an authenticated remote execution
service, so `.openai/hosting.json` only preserves the future Sites integration.
