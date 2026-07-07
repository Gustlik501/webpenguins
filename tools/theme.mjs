// Parser for the original xpenguins theme `config` format (see
// vendor/xpenguins-2.2.orig/themes/Penguins/config for the grammar by example).

const NUM_PROPS = new Set([
  "width",
  "height",
  "frames",
  "speed",
  "directions",
  "acceleration",
  "terminal_velocity",
  "loop",
]);

export function parseThemeConfig(text) {
  const tokens = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, "");
    for (const t of line.trim().split(/\s+/)) if (t) tokens.push(t);
  }

  const theme = { delay: 60, genera: [] };
  const defaults = {};
  let genus = null;
  let current = null; // either `defaults` or an animation definition

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === "delay") {
      theme.delay = Number(tokens[++i]);
    } else if (t === "toon") {
      genus = { name: tokens[++i], number: 1, anims: {} };
      theme.genera.push(genus);
    } else if (t === "define") {
      const name = tokens[++i];
      if (name === "default") {
        current = defaults;
      } else {
        current = { ...defaults };
        genus.anims[name] = current;
      }
    } else if (t === "number") {
      genus.number = Number(tokens[++i]);
    } else if (t === "pixmap") {
      current.pixmap = tokens[++i];
    } else if (NUM_PROPS.has(t)) {
      current[t] = Number(tokens[++i]);
    } else {
      console.warn(`theme config: ignoring unknown token "${t}"`);
      i++; // skip its value too
    }
  }
  return theme;
}
