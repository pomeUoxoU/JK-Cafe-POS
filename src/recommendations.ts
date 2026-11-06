import type { Catalog, Line } from "./shared";

// Array order is the fixed tie-break priority; this is display logic only.
export const recommendedRecipes = [
  { id: "choco-cream-oreo", syrup: "choco", toppings: ["cream", "oreo"] },
  {
    id: "berry-cream-sprinkles",
    syrup: "berry",
    toppings: ["cream", "sprinkles"],
  },
  { id: "maple-cream-ice", syrup: "maple", toppings: ["cream", "ice"] },
  { id: "choco-sprinkles-ice", syrup: "choco", toppings: ["sprinkles", "ice"] },
] as const;

export function recommendToppings(line: Line | null, catalog: Catalog[]) {
  if (!line) return [];
  const special =
    catalog.find((p) => p.id === line.productId)?.category === "special";
  const selected = new Set<string>(
    special ? ["sprinkles", "ice", line.includedId] : [line.includedId],
  );
  for (const extra of line.extras)
    if (extra.quantity > 0) selected.add(extra.id);
  const name = (id: string) => catalog.find((p) => p.id === id)?.name || id;
  const ranked = recommendedRecipes
    .map((recipe, priority) => {
      const matched = recipe.toppings.filter((id) => selected.has(id));
      const missing = recipe.toppings.filter((id) => !selected.has(id));
      return { recipe, priority, matched, missing };
    })
    .filter(
      (r) =>
        r.recipe.syrup === line.syrupId &&
        r.matched.length > 0 &&
        r.missing.length > 0,
    )
    .sort(
      (a, b) =>
        Number(b.missing.length === 1) - Number(a.missing.length === 1) ||
        b.matched.length - a.matched.length ||
        a.priority - b.priority,
    );
  const seen = new Set<string>();
  return ranked.flatMap(({ recipe, matched, missing }) =>
    missing.flatMap((id) => {
      const item = catalog.find((p) => p.id === id);
      if (
        seen.has(id) ||
        selected.has(id) ||
        !item?.active ||
        item.stock <= 0 ||
        !["normal", "ice"].includes(item.category)
      )
        return [];
      seen.add(id);
      return [
        {
          item,
          recipeId: recipe.id,
          context: `${[name(recipe.syrup), ...matched.map(name)].join("×")}におすすめ`,
          reason:
            missing.length === 1
              ? `${item.name}を追加して完成！`
              : `${item.name}を合わせる`,
        },
      ];
    }),
  );
}
