// y-monaco only needs these constructors at runtime. Randori's existing
// Monaco loader owns the actual editor instance; this shim avoids bundling a
// second editor runtime while keeping y-monaco itself pinned and local.
export class Selection {
  constructor(...args){ return new window.monaco.Selection(...args); }
  static createWithDirection(...args){ return window.monaco.Selection.createWithDirection(...args); }
}

export class Range {
  constructor(...args){ return new window.monaco.Range(...args); }
}

export const editor={};
