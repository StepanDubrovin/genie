import { modelName, moneyText, type Spend, tokensText, tokensTotal } from "../model.ts";

/** The models of a spend, one a line, for a tooltip. */
export function spendTitle(s: Spend): string {
  return s.models
    .map((m) => `${modelName(m.model)}: ${m.cost === null ? "цена не указана" : moneyText(m.cost)}, ${tokensText(tokensTotal(m.tokens))} токенов`)
    .join("\n");
}

/** «$4,20 · 1,3 млн токенов» with the models under the pointer; `extra` follows the tokens. */
export function SpendText({ spend, extra }: { spend: Spend; extra?: string }) {
  const priced = spend.models.some((m) => m.cost !== null);
  const tokens = `${tokensText(tokensTotal(spend.tokens))} токенов`;
  return (
    <span title={spendTitle(spend)} style={{ display: "inline-flex", alignItems: "baseline", gap: 8, minWidth: 0, flexWrap: "wrap" }}>
      {priced && <b style={{ fontWeight: 600, fontVariantNumeric: "tabular-nums" }}>{moneyText(spend.cost)}</b>}
      <span className="muted" style={{ fontSize: 12 }}>
        {priced ? tokens : `${tokens} · цена модели не указана`}
        {extra ? ` · ${extra}` : ""}
      </span>
    </span>
  );
}
