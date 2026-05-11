# receipt-gen

Type free-text on the left with light markdown, get a printed
dot-matrix receipt on the right. Download as PNG.

## dev

```
npm install
npm run dev
```

opens at `http://localhost:5181/`.

## markdown

Inline:

- `**bold**`
- `*italic*`
- `~~strikethrough~~`

Per-line directives (must start the line with the leading dot):

- `.center`, `.left`, `.right` — alignment
- `.title` — bigger centered heading
- `.small` — smaller dimmer text
- `.rule` — dotted rule across the receipt width
- `.row LEFT  RIGHT` — two-column row (split on 2+ spaces between the columns)

Blank lines render as empty rows (preserve vertical spacing).

## print

The **print** button replays the receipt one character at a time with
the bidirectional DMP head pattern (line 1 L→R, line 2 R→L, etc).
Bold-emphasised lines and `.title` lines print at half speed for
audible emphasis.

The **printer sounds** checkbox enables per-character ticks, paper
feed swooshes, and a low engine bed. WebAudio is unlocked on toggle
since browsers won't let audio start without a user gesture.

## download

**download PNG** rasterises the receipt at 2× DPR via an inline-styled
SVG `<foreignObject>` so the output matches the on-screen render
exactly (including the dot-matrix font, which is embedded as a data
URI). Result is named `receipt.png`.
