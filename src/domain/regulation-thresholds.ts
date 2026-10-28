import type { NormativeRules } from './normative-parameters'

/** Effective paired ГОСТ/ОДМ bounds; strict/inclusive comparisons belong to each rule.
 * Sources and confirmations remain in NormativeRules, with no new normative constants.
 */
export function regulationThresholds(rules: NormativeRules) {
  return {
    signsHourly: Math.min(rules.signsHourly, rules.workTraffic.signsHourly),
    alternateHourly: Math.min(rules.alternateHourly, rules.workTraffic.alternateHourly),
    signsLengthMetres: Math.min(rules.signsLengthMetres, rules.workTraffic.signsLength),
  }
}
