/** Minimalny parser/serializer formatu .bru (bloki najwyższego poziomu). */

export type Block = { name: string; body: string[] };

export function parseBru(text: string): Block[] {
  const blocks: Block[] = [];
  let cur: Block | null = null;
  for (const line of text.split(/\r?\n/)) {
    if (!cur) {
      const m = line.match(/^([\w:\-]+)\s*\{\s*$/);
      if (m) cur = { name: m[1], body: [] };
      continue;
    }
    if (line === "}") {
      blocks.push(cur);
      cur = null;
      continue;
    }
    cur.body.push(line);
  }
  return blocks;
}

export function serializeBru(blocks: Block[]): string {
  return blocks.map((b) => `${b.name} {\n${b.body.join("\n")}\n}`).join("\n\n") + "\n";
}

export function dictBlock(name: string, obj: Record<string, string | number | boolean>): Block {
  return { name, body: Object.entries(obj).map(([k, v]) => `  ${k}: ${v}`) };
}

export function readDict(block?: Block): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of block?.body ?? []) {
    const m = line.match(/^\s+([^:]+?):\s?(.*)$/);
    if (m) out[m[1].trim()] = m[2];
  }
  return out;
}

export function textBlock(name: string, content: string): Block {
  return { name, body: content.split("\n").map((l) => (l ? "  " + l : l)) };
}

/** Zamienia (lub dopisuje) bloki o podanych nazwach, zachowując resztę pliku. */
export function upsertBlocks(blocks: Block[], replacements: Block[]): Block[] {
  const names = new Set(replacements.map((b) => b.name));
  const kept = blocks.filter((b) => !names.has(b.name));
  // meta zawsze pierwsze, potem nowe bloki, potem reszta
  const meta = kept.filter((b) => b.name === "meta");
  const rest = kept.filter((b) => b.name !== "meta");
  return [...meta, ...replacements, ...rest];
}

export function slugify(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/ł/g, "l")
    .replace(/Ł/g, "L")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
