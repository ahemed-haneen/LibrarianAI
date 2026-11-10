export type CostHint = 'low' | 'premium' | 'unknown';

/**
 * Name-based hint only. VS Code does not expose a model's premium-request multiplier, so the page
 * labels this as a hint and tells the user to confirm against their plan.
 */
export function costHint(family: string, name = ''): CostHint {
  const s = `${family} ${name}`.toLowerCase();
  if (/(^|[^a-z])(mini|nano|flash|haiku|lite|small)\b|gpt-4\.1(?![\d.])|gpt-4o(?!\S)/.test(s) && !/opus/.test(s)) {
    return 'low';
  }
  if (/opus|sonnet|\bo1\b|\bo3\b(?!-mini)|gpt-5(?!(\.\d+)?-mini)|gemini.*pro|gpt-4\.5|fable|mythos/.test(s)) {
    return 'premium';
  }
  return 'unknown';
}
