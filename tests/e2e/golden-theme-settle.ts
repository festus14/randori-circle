import {Page} from '@playwright/test';

// Shared settle-wait for the golden specs' theme-toggle → axe paths (issues
// #390, #391). Extracted verbatim in behaviour from the per-spec helper
// #390 landed in the account-deletion spec, then generalised to the other
// golden regions (below) so the wait lives in one place.
//
// The old helpers only waited for the `light` class to appear, then ran axe
// immediately. The class toggles synchronously, but the colours it drives
// animate over 120 ms — with a per-class split: `.input` transitions
// `background-color` but not `color`, so its foreground snaps to the new
// theme while its background lags behind; `.btn` transitions both. Either
// way, on a slow runner axe sampled a transition frame — dark-theme colours
// (`#0b0d12` background, contrast 1.04 on #accountDeletionPassword) in the
// "light" run. Wait until the transition has actually finished before axe
// runs:
//  - a sentinel element's computed background + foreground equal the settled
//    values for the target theme, read live from the CSS variables — no
//    colour is hardcoded, so a palette change cannot silently turn this
//    into a fixed sleep / stale assertion. The sentinel is resolved per
//    scanned region, in this order:
//      1. `#accountDeletionPassword` (the #390 failing element, when present
//         and enabled) — `--color-field` / `--color-text`.
//      2. The first enabled `input.input` — `--color-field` / `--color-text`.
//      3. The first enabled `.btn.danger` — `--color-danger` / `--color-on-danger`.
//      4. The first enabled `button.btn`, with the palette of its variant:
//         primary `--color-action` / `--color-on-action`, secondary
//         `--color-surface` / `--color-text`, ghost `transparent` /
//         `--color-text-secondary` (a ghost button's background is
//         transparent, so #390's primary palette would never match it —
//         that is the exercise-suggestions region, whose first `.btn` is a
//         ghost Hide button), danger as in (3). Disabled controls are
//         skipped (`:disabled`, plus `aria-disabled` on `.btn`, which shares
//         the disabled palette `--color-surface-active` / `--color-text-muted`), and a non-`.btn`
//         button has no themed background at all, so either would never
//         equal the settled theme variables and the wait would time out
//         opaquely instead of checking a real transitioning element.
//      5. The first `.chip` (reminders: the Email label, the only
//         transitioning element in `#psRemindRow`) — `--color-surface` /
//         `--color-text-secondary`. An active chip uses the action-subtle
//         palette instead, so active chips are skipped.
//      6. The first themed container: the region itself or its first
//         `.card` / `.catalog-suggestions` / `.catalog-list` /
//         `.catalog-card` / `.modal` / `.rc-dialog` descendant
//         (`--color-surface` / `--color-text`), or `.onboarding-row` /
//         `.rc-card--raised` (`--color-surface-raised` / `--color-text`),
//         or a current `.catalog-card[aria-current="true"]`
//         (`--color-action-subtle` / `--color-text`).
//         This covers regions with no control at all (progress: no input
//         or button, only the inner `.card`; the region root itself has no
//         background, so #390's root fallback, which assumed
//         `--color-surface`, would time out there).
//    If no sentinel can be identified at all, only the class + animation
//    checks below apply, rather than timing out on a guessed palette.
//  - no CSS transition/animation is still running on any rendered element
//    inside any scanned region (`getAnimations()`). Animations on
//    non-rendered elements are ignored: Firefox leaves the transitions of
//    elements in a `display:none` subtree (e.g. the hidden invite form on
//    the landing page after a successful request) reporting
//    `playState: 'running'` indefinitely — in the instrumented Firefox
//    failure the sentinel colours already matched the settled palette, but
//    transitions on elements inside `#view-landing` never finished, so the
//    wait timed out at 10 s. Those elements paint nothing (no layout box
//    anywhere in their subtree, and `[hidden]{display:none!important}` in
//    index.html is what hides them), so they cannot affect the axe run the
//    wait gates. An element counts as rendered if it owns a layout box
//    itself or has a descendant that does, so a `display:contents` ancestor
//    — box-less, but rendering through descendants whose inherited colours
//    its own transition would still animate — is NOT skipped. Visible
//    transitions still block: under `reducedMotion: 'reduce'` they are
//    0.01 ms, and the sentinel-colour check still gates on them.
// This is a poll on the settled state, not a fixed timeout, so it cannot
// pass by luck on a slow runner; if the theme never settles it times out
// instead of running axe mid-transition.
//
// `selector` may be a single selector or a list when one axe run covers
// several regions (exercise suggestions scans `#exerciseSuggestions` and
// `#catalogList` together).

export async function waitForThemeSettled(page:Page,selector:string|string[],light:boolean){
  const selectors=Array.isArray(selector)?selector:[selector];
  await page.waitForFunction(([targetSelectors,wantLight])=>{
    if(document.documentElement.classList.contains('light')!==wantLight) return false;
    const rootStyle=getComputedStyle(document.documentElement);
    const toRgb=(hex:string)=>{
      const value=hex.trim().replace(/^#/,'');
      if(value.length!==6) return hex.trim();
      return `rgb(${Number.parseInt(value.slice(0,2),16)}, ${Number.parseInt(value.slice(2,4),16)}, ${Number.parseInt(value.slice(4,6),16)})`;
    };
    const expected=(bgVar:string,fgVar:string)=>{
      const bg=bgVar==='transparent'?'rgba(0, 0, 0, 0)':toRgb(rootStyle.getPropertyValue(bgVar));
      return {bg,fg:toRgb(rootStyle.getPropertyValue(fgVar))};
    };
    const buttonPalette=(button:Element)=>{
      // No `danger` branch: step 3 above already picks any enabled
      // `.btn.danger` (same `:disabled` / `aria-disabled` filters), so a
      // danger button can never reach here as the first `button.btn`.
      // CSS cascade order in index.html: ghost beats secondary.
      if(button.classList.contains('ghost')) return {bgVar:'transparent',fgVar:'--color-text-secondary'};
      if(button.classList.contains('secondary')) return {bgVar:'--color-surface',fgVar:'--color-text'};
      return {bgVar:'--color-action',fgVar:'--color-on-action'};
    };
    const containerPalette=(element:Element)=>{
      // Variant palettes, checked before the generic `--color-surface` one
      // below — otherwise a current catalog card / raised card / dialog
      // would be checked against the wrong background and the wait would
      // time out opaquely. Verified against index.html: the current
      // catalog card uses `var(--color-action-subtle)`, `.rc-card--raised`
      // uses `var(--color-surface-raised)`, and
      // `.modal` / `.rc-dialog` use `var(--color-surface)`;
      // all three inherit `--color-text` for foreground.
      if(element.classList.contains('catalog-card')&&element.getAttribute('aria-current')==='true')
        return {bgVar:'--color-action-subtle',fgVar:'--color-text'};
      if(element.classList.contains('rc-card--raised')) return {bgVar:'--color-surface-raised',fgVar:'--color-text'};
      if(element.classList.contains('modal')||element.classList.contains('rc-dialog'))
        return {bgVar:'--color-surface',fgVar:'--color-text'};
      if(element.classList.contains('onboarding-row')) return {bgVar:'--color-surface-raised',fgVar:'--color-text'};
      if(element.classList.contains('card')||element.classList.contains('catalog-suggestions')
        ||element.classList.contains('catalog-list')||element.classList.contains('catalog-card')) {
        return {bgVar:'--color-surface',fgVar:'--color-text'};
      }
      return null;
    };
    for(const targetSelector of targetSelectors){
      const root=document.querySelector(targetSelector);
      if(!root) return false;
      let sentinel:Element|null=null;
      let palette:{bgVar:string;fgVar:string}|null=null;
      const pick=(candidate:Element|null,next:{bgVar:string;fgVar:string})=>{
        if(candidate&&!sentinel){ sentinel=candidate; palette=next; }
      };
      pick(root.querySelector('#accountDeletionPassword:not(:disabled)'),{bgVar:'--color-field',fgVar:'--color-text'});
      pick(root.querySelector('input.input:not(:disabled)'),{bgVar:'--color-field',fgVar:'--color-text'});
      pick(root.querySelector('.btn.danger:not(:disabled):not([aria-disabled="true"])'),
        {bgVar:'--color-danger',fgVar:'--color-on-danger'});
      const button=root.querySelector('button.btn:not(:disabled):not([aria-disabled="true"])');
      if(button) pick(button,buttonPalette(button));
      pick(root.querySelector('.chip:not(.active):not([aria-pressed="true"])'),
        {bgVar:'--color-surface',fgVar:'--color-text-secondary'});
      if(!sentinel){
        for(const element of [root,...root.querySelectorAll('.card, .catalog-suggestions, .catalog-list, .catalog-card, .onboarding-row, .rc-card--raised, .modal, .rc-dialog')]){
          const next=containerPalette(element);
          if(next){ sentinel=element; palette=next; break; }
        }
      }
      if(sentinel&&palette){
        const style=getComputedStyle(sentinel);
        const target=expected(palette.bgVar,palette.fgVar);
        if(style.backgroundColor!==target.bg) return false;
        if(style.color!==target.fg) return false;
      }
      // An element is rendered if it owns a layout box, or an ancestor of
      // one that does (display:contents renders through its descendants).
      // Mark ancestors of every box-owning element, stopping at the first
      // already-marked ancestor: marking is transitive, so its ancestors
      // were marked when it was.
      const rendered=new Set<Element>();
      for(const element of [root,...root.querySelectorAll('*')]){
        if(element.getClientRects().length===0) continue;
        for(let node:Element|null=element;node&&!rendered.has(node);node=node.parentElement) rendered.add(node);
      }
      for(const element of [root,...root.querySelectorAll('*')]){
        if(!rendered.has(element)) continue;
        for(const animation of element.getAnimations()){
          if(animation.playState==='running') return false;
        }
      }
    }
    return true;
  },[selectors,light],{timeout:10_000,polling:10});
}
