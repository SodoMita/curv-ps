# Curv+solve

A browser playground for [Curv](https://github.com/curv3d/curv) 2D shapes (F-Rep compiled to WGSL for WebGPU,
with a JS fallback) extended with `solve { … }` blocks: linear / convex-quadratic constraints solved by
[psolve](https://github.com/SodoMita/psolve) compiled to WebAssembly.

```curv
let
  L = solve {
    var side, main : box;  var cards : box[6];
    pin 16 viewport side;  side.w == 200;  main.left == side.right + 14;  main.right == viewport.right - 16;
    grid 14 3 main cards;          // a prelude combinator that returns constraints
  };
in union [ card L.side, for (c in L.cards) card c ]
```

* `npm install && npm run dev` — development server
* `npm run build` — single-file `dist/index.html`
* `npx tsx scripts/selftest.ts` — headless render of every example
* `npx tsx scripts/paramcheck.ts` — verifies the codegen fast path

See [HANDOFF.md](HANDOFF.md) for the architecture, invariants and the current state of development.
