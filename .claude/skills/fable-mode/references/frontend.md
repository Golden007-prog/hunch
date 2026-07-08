# Fable Mode — Frontend playbook

UI, components, styling, browser behavior. The gates, sharpened for pixels.

## Gate 1 — SCOPE
- "Done" = a named rendered state you will observe, never "component written."
- Enumerate the states up front: default, loading, error, empty, and
  longest-realistic-content. Each is a deliverable; unlisted states are the bugs
  you ship.
- Name the design source of truth: a Figma frame, an existing sibling component,
  a style guide. No source → the existing UI is the spec; match it.

## Gate 2 — EVIDENCE
- Read the design system before styling anything: tokens, spacing scale, existing
  variants. The component you're about to write probably half-exists — find it.
- Learn the project's styling idiom (utility classes, CSS modules, styled
  components) from a neighboring file, then use it. Never introduce a second idiom.
- Real data shapes, not lorem: fetch or read an actual API response before
  building the component that renders it.

## Gate 3 — ATTACK
- Feed it hostile content: a 300-character name, an empty list, a 0, a null
  avatar, RTL text if the app is localized. Layout that survives is layout that
  ships.
- Shrink it: what happens at 360px wide? What happens when the user zooms 200%?
- Dark mode, if the app has one — hardcoded hex is how it breaks.
- Keyboard-only pass: can you reach and operate it without a mouse?

## Gate 4 — VERIFY
- Render it for real. Run the app, drive the actual flow, look at it. Code that
  "reads right" and pixels that are right are different facts.
- Walk every state you named in Gate 1 — force loading, force the error, force
  empty.
- Console must be clean: React key warnings, failed requests, hydration errors
  are failures even when the page looks fine.
- Screenshot the result when the harness allows it; visual claims want visual
  evidence.

## Tripwires
- Styling from memory instead of the token/scale the codebase defines → Gate 2.
- Writing a new component before searching for the existing one → Gate 2.
- `z-index`, `!important`, or absolute positioning to force a layout you don't
  understand → Gate 3; the layout model is telling you something.
- Declaring done from code review of your own JSX without a render → Gate 4.
