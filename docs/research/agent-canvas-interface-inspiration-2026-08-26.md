# Agent and canvas interface inspiration

Date: 2026-08-26

Scope: primary-source research on Miro Sidekicks, VS Code Chat, Notion AI, ChatGPT Canvas, FigJam, and WCAG. The recommendations below are product conclusions for Somite, not claims that every referenced product implements the same layout.

## Recommended direction

Somite should treat the AI as a quiet canvas collaborator, not a connection dashboard:

1. Rename **Workflow Agent** to **Agent** everywhere.
2. Put the Agent launcher on the right, adjacent to the right-side Agent surface. Closing the panel should leave a small persistent Agent tab on that same edge, with an unread/running dot when relevant.
3. Default to a compact 360 px docked panel. Resize from its inner edge (roughly 300–720 px), persist the width, and allow the header to be dragged into a floating mode or snapped back to either edge. The close button hides it; a separate collapse control reduces it to the edge tab without ending the conversation.
4. After connection, show only a status dot, `Agent`, conversation, and composer. Move the agent command, ACP version, registry source, model/mode selectors, tool names, raw arguments, and disconnect action into an overflow menu or **Connection details** disclosure. Errors may reveal the relevant detail automatically.
5. Replace the event-card stream with a human conversation. During work, show one compact live row such as `Building the workflow · 3 steps`; completed tool activity becomes a collapsed `Completed 3 steps` disclosure. Keep the semantic outcome visible: what changed, what still needs attention, and the next useful action.
6. Make prompts contextual. A selected node, edge, readiness issue, or group should appear as a removable context chip above the composer. Empty-state starters should be workflow actions such as **Build from my files**, **Fix what is missing**, **Explain this step**, and **Check this workflow**—not agent configuration choices.
7. Add **Sticky**, **Pen**, and **Box** to the bottom creative toolbar. Selection should reveal a compact contextual palette. Node color should be available in that same selection toolbar, with a small curated palette and an optional text label such as `Input`, `QC`, `Analysis`, `Review`, or `Output`; color must never be the only carrier of stage or status.

## What the strongest interfaces establish

### Context beats setup chrome

Miro lets users select board objects before prompting a Sidekick, and the selected stickies, images, formats, or other objects become prompt context. Its newer unified Sidekick also begins with suggestions and keeps iteration in one conversation instead of making users select among separate AI tools. This supports one **Agent** surface whose suggestions respond to the current workflow selection. [Miro: Sidekicks](https://help.miro.com/hc/en-us/articles/30139627329042-Sidekicks), [Miro: Sidekicks evolve AI creation](https://help.miro.com/hc/en-us/articles/33881743175954-Sidekicks-evolve-AI-creation-in-Miro)

ChatGPT Canvas similarly opens work on the right, lets the user highlight the exact content to discuss, and offers focused shortcuts beside direct editing. The transferable pattern is selection → visible context → targeted action, not a generic transcript detached from the artifact. [OpenAI: Canvas help](https://help.openai.com/en/articles/9930697-what-is-the-canvas-feature-in-chatgpt-and-how-do-i-use-it), [OpenAI: Introducing canvas](https://openai.com/index/introducing-canvas/)

Notion keeps AI easy to recover through a small bottom-right launcher, a sidebar entry, a keyboard shortcut, and conversation history. Its published interaction examples emphasize clear answers and one-click skills rather than exposing search or model plumbing. Somite should preserve the Agent thread after collapse and make reopening it a one-click action. [Notion: Everything you can do with Notion AI](https://www.notion.com/help/guides/everything-you-can-do-with-notion-ai)

### A docked panel should be flexible without becoming chaotic

VS Code places Chat in a secondary sidebar beside the work, offers compact and side-by-side modes, and lets views move between regions while remembering the layout across sessions. Its agent window also restores side-pane width and collapsed state. This supports a resizable docked default and persistent layout state. A draggable floating mode is a deliberate Somite extension: official Miro and Figma documentation does not establish draggable AI panels as a standard. [VS Code: Chat view](https://code.visualstudio.com/docs/agents/run/chat-view), [VS Code: Custom layout](https://code.visualstudio.com/docs/configure/custom-layout), [VS Code: Agents window](https://code.visualstudio.com/docs/agents/run/agents-window)

Use explicit panel states:

- **Open/docked:** 360 px default, canvas remains primary.
- **Resizing:** inner-edge handle, keyboard-operable width alternatives, remembered per user.
- **Floating:** drag by header; constrain it inside the canvas and expose visible snap targets near left/right edges.
- **Collapsed:** 44–48 px right-edge Agent tab showing idle, working, needs-input, or unread state with both icon and accessible text/label.
- **Closed:** no panel, no lost session; the right-side toolbar button remains.

### Technical activity belongs behind progressive disclosure

VS Code renders subagents as collapsed tool calls by default and provides settings that group tool activity into collapsible sections. Raw prompts, request payloads, and tool input/output live in separate debug views. That is the correct division for Somite: ordinary users see progress and results; diagnostics remain available on demand. [VS Code: Subagents](https://code.visualstudio.com/docs/agents/run/subagents), [VS Code: AI settings](https://code.visualstudio.com/docs/agents/reference/ai-settings), [VS Code: Debug chat interactions](https://code.visualstudio.com/docs/agents/agent-troubleshooting/chat-debug-view)

Recommended message hierarchy:

- Always show user messages, concise Agent responses, questions requiring an answer, canvas changes, readiness results, and errors with recovery actions.
- Collapse reads, searches, MCP/tool calls, raw parameters, intermediate status events, transaction identifiers, registry details, and protocol/version strings.
- Summarize a successful edit as a semantic result such as `Added Kraken2 after trimming` with **View on canvas** and **Undo**, rather than `transaction completed`.
- Put **Connection details**, **Agent settings**, **Diagnostics**, and **Disconnect** in the header overflow menu.

### Creative tools should be immediate and object-centered

FigJam makes a sticky a direct manipulation: press `S` or choose Sticky, place it, and type immediately. Selected stickies expose color and formatting; their width can be dragged, and color changes can become the default for future stickies. Somite should mirror this fast path and avoid a creation dialog. [Figma: Sticky notes in FigJam](https://help.figma.com/hc/en-us/articles/1500004414322-Sticky-notes-in-FigJam)

FigJam's marker uses `M`, supports a small color and weight choice, stays active until another tool or `Esc`, and allows strokes to be recolored after drawing. Its highlighter and eraser share the same drawing-tool family. For Somite's first release, a pen with color, two stroke weights, `Esc` to return to Select, and selectable/deletable strokes is enough; an eraser can delete whole strokes rather than pixels. [Figma: Drawing tools](https://help.figma.com/hc/en-us/articles/1500004414442-Doodle-and-highlight-in-FigJam-with-drawing-tools)

FigJam uses curated palettes for stickies, drawings, and shapes, and exposes object color only when the object or creation tool is active. Shapes support fill, transparency, border, and opacity. Somite should likewise keep the main toolbar compact and reveal node, box, sticky, or stroke styling contextually after selection. [Figma: Apply colors in FigJam](https://help.figma.com/hc/en-us/articles/1500004291341-Apply-colors-in-FigJam)

## Light-mode and color requirements

Light mode should use a solid readable foreground over both panels and the gridded canvas. WCAG 2.1 AA requires at least **4.5:1** contrast for normal text and **3:1** for large text; necessary control boundaries, icons, focus indicators, and meaningful graph elements need **3:1** against adjacent colors. These are thresholds, so target modestly higher values for small/thin UI text. [W3C: Text contrast](https://www.w3.org/WAI/WCAG21/Understanding/contrast-minimum), [W3C: Non-text contrast](https://www.w3.org/WAI/WCAG21/Understanding/non-text-contrast)

Color coding is useful, but WCAG prohibits using color as the only way to convey information or state. A colored node therefore also needs a visible label, icon, border treatment, or text tag when the color has meaning. User-chosen decorative colors need no fixed semantic meaning; stage presets do. [W3C: Use of color](https://www.w3.org/WAI/WCAG21/Understanding/use-of-color)

Practical Somite rules:

- Use a near-charcoal primary light-mode text token and a darker secondary token; do not place faint gray text directly over the grid.
- Give nodes an opaque surface so the grid does not become part of the text's effective background.
- Keep node titles, port labels, toolbar labels, placeholders, and Agent metadata at 4.5:1 or better.
- Keep selection outlines, ports, resize handles, focus rings, and toolbar icons at 3:1 or better.
- Provide stage labels alongside the curated colors; never map red/green alone to invalid/valid.

## Recommended implementation order

1. Rename and relocate Agent; add collapsed/reopen state and simplify connected chrome.
2. Collapse technical events into a single progress disclosure and rewrite result cards in workflow language.
3. Add resize persistence, then header drag/dock behavior.
4. Correct light-mode tokens and verify the actual adjacent color pairs.
5. Add Sticky and Box with direct placement, inline editing, and selection palettes.
6. Add Pen/stroke objects and node color plus optional stage labels.

The key acceptance test is not visual polish alone: a new user should be able to reopen Agent, ask about a selected node, understand what changed, add a colored note, and identify every meaningful workflow state without learning ACP, MCP, registry, transaction, or tool-call terminology.
