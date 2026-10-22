# MiniMax Pet artwork

The bundled `minimax-original` pet and `icon.png` are original geometric artwork created for this plugin. Copyright (c) 2026 MiniMax. They are distributed under the plugin's [MIT License](LICENSE).

The editable source is `scripts/generate-pet-art.mjs` in `sources/minimax-ai/minimax-pet`. It draws the character and encodes its PNGs using Node built-ins, without loading external images, fonts, or models. To regenerate from that source:

```sh
npm run generate:art
```

The generated atlas is 1536 × 2288 pixels: eight 192 × 208 cells per row, nine animation rows and two rows of look directions. It is compatible with the existing player, including idle, running, waving, jumping, failure, waiting, work and review poses. Tests compare decoded pixels with a fresh deterministic generation, so PNG compression differences between Node releases do not change the artwork contract. The source/distribution package check still compares every shipped file byte.

No third-party character art or externally sourced pet spritesheet is included in the current package. User-imported artwork is not part of this distribution and keeps its own license.
