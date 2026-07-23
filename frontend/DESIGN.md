# BioMed-QAgent Frontend Design System

## 1. Atmosphere & Identity

BioMed-QAgent is a quiet biomedical research console: operational, precise, and information-dense without feeling crowded. Its signature is restrained clinical depth, using cool mist surfaces, sky-blue actions, compact metadata, and clear state transitions rather than decorative effects.

## 2. Color

The authoritative palette is the semantic token set in `src/styles/global.css`.

| Role | Token | Usage |
|---|---|---|
| Main surface | `background` | Page and dialog background |
| Raised surface | `card`, `popover` | Cards, dropdowns, overlays |
| Primary text | `foreground` | Titles and body copy |
| Secondary text | `muted-foreground` | Help text, metadata, units |
| Action | `primary`, `primary-foreground` | Primary buttons, links, focus |
| Secondary state | `secondary`, `accent`, `muted` | Selected rows, quiet controls, grouping |
| Boundary | `border`, `input`, `ring` | Dividers, controls, focus rings |
| Error | `destructive` | Invalid input and failed operations |

Rules:
- Use semantic Tailwind classes only; do not add raw colors to product components.
- Reserve `primary` for actions and selected state, never decoration.
- Success, warning, and error meaning must include text or an icon, not color alone.

## 3. Typography

| Level | Treatment | Usage |
|---|---|---|
| Dialog/page title | `text-lg font-semibold` | Primary surface title |
| Card title | shadcn `CardTitle` | Settings and workspace sections |
| Body | `text-sm` or component default | Forms and operational copy |
| Help/metadata | `text-xs text-muted-foreground` | Units, sources, constraints |
| Numeric | `font-mono tabular-nums` | Tokens, ratios, capacities |

Primary font is Inter Variable. Numeric and code values use the configured monospace stack. Product body text should not be smaller than 14px; 12px is limited to metadata.

## 4. Spacing & Layout

Spacing follows Tailwind's 4px base scale. Forms use shadcn `FieldGroup` and `Field`; component clusters use flex/grid with `gap-*`, never `space-*`.

- Settings dialog: intrinsic full-width shell capped at 90rem with one scroll owner per tab.
- Form rhythm: `gap-5` between fields, `gap-2` or `gap-3` within a field.
- Responsive behavior: one readable column at 375px; two-column metric/input groups may begin at `md`.
- Primary content must not horizontally scroll. Long model IDs truncate or wrap without covering actions.

## 5. Components

### Settings Surface
- **Structure**: `Dialog` -> header -> `Tabs` -> `Card` -> `FieldGroup` -> footer action.
- **States**: loading skeleton, clean, dirty, saving, validation error, backend rejection.
- **Accessibility**: labeled controls, `aria-invalid`, `FieldError`/`Alert`, keyboard-reachable tabs and actions.
- **Motion**: use existing dialog/tab transitions only.

### Context Budget Summary
- **Structure**: semantic `Alert` or compact card section with exact context source, context window, output allowance, safety reserve, and available input.
- **Variants**: valid catalog, valid user override, unknown model requiring input, invalid budget.
- **States**: values update synchronously with draft inputs; errors remain adjacent to the controlling field.
- **Accessibility**: values have textual labels and units; source is written as text; no color-only status.
- **Layout**: responsive metric grid, one column on narrow screens.

### Model Configuration Fields
- **Structure**: `FieldSet`/`FieldGroup`, labeled numeric `Input` controls, descriptions, and `FieldError`.
- **States**: default, dirty, invalid, disabled during save, rejected by backend.
- **Validation**: frontend mirrors integer/ratio arithmetic for immediate guidance; backend response remains authoritative.
- **Layout**: advanced ratios are grouped separately from core model/window/output fields.

## 6. Motion & Interaction

- Micro interactions use existing shadcn hover, focus, and pressed behavior.
- Do not add decorative animation. Update calculated token values immediately without transition.
- Animate only `transform` and `opacity`; honor `prefers-reduced-motion` through existing global rules.
- Saving disables the primary action and shows the existing spinner. A failed save retains the draft and the last confirmed settings snapshot.

## 7. Depth & Surface

Use a mixed but restrained strategy already present in the codebase: semantic borders define cards and controls; `shadow-sm` is limited to compact elevated information and dropdowns; dialogs/popovers use their shadcn elevation. Do not add new shadow levels.

## 8. Accessibility Constraints & Accepted Debt

### Constraints
- Target WCAG 2.2 AA: visible focus, keyboard reachability, 4.5:1 body-text contrast, and 3:1 large-text/UI-component contrast.
- Validation uses `data-invalid` on `Field`, `aria-invalid` on controls, and a textual `FieldError` or `Alert`.
- Numeric controls expose exact values and constraints without requiring pointer drag.
- At 375px, context controls and summary reflow without clipping or horizontal scrolling.

### Personas
- Biomedical researcher: needs trustworthy units and model-source labels without understanding tokenization internals.
- Operator configuring a compatible endpoint: needs an explicit path for unknown models and actionable validation.
- Keyboard or low-vision user: needs ordered focus, adjacent errors, and non-color status labels.

### Accepted Debt

| Item | Location | Why accepted | Owner / Exit |
|---|---|---|---|
| React inspection tooling is not installed | `frontend/package.json` | This feature must add no dependencies; existing lint, type, test, build, and browser gates remain authoritative | Revisit as a dedicated tooling task |
| Legacy temperature/top-p controls use raw range inputs | `src/components/SettingsPanel.tsx` | Unrelated to context-budget behavior | Replace when model-generation controls are redesigned |
