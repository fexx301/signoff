import type { AcceptanceCriteria, Artifact, CombinedVerdict, DeterministicCheck, ServVerdict } from "./types.js";

const BUILT_IN_CANARIES = [
  "ignore the acceptance criteria",
  "ignore all acceptance criteria",
  "ignore previous instructions",
  "ignore all previous instructions",
  "disregard the acceptance criteria",
  "return pass",
  "respond with pass",
  "you are the grader",
  "note to automated reviewer",
  "system prompt",
];

function normalize(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

function words(text: string): number {
  return text
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/[#>*_`~-]/g, " ")
    .split(/\s+/)
    .filter(Boolean).length;
}

function urls(text: string): string[] {
  const found = text.match(/https?:\/\/[^\s)\]>"']+/g) ?? [];
  return [...new Set(found.map((url) => url.replace(/[.,;:]+$/, "")))];
}

function headingPresent(content: string, section: string): boolean {
  const escaped = section.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const heading = new RegExp(`^#{1,4}\\s*${escaped}\\s*$`, "im");
  if (heading.test(content)) return true;
  // Accept a bold-only heading (e.g. "**Market landscape**") for model variance.
  const bold = new RegExp(`^\\*\\*${escaped}\\*\\*\\s*$`, "im");
  return bold.test(content);
}

export function deterministicChecks(content: string, criteria: AcceptanceCriteria): DeterministicCheck[] {
  const checks: DeterministicCheck[] = [];

  const missingSections = criteria.requiredSections.filter((section) => !headingPresent(content, section));
  checks.push({
    id: "required_sections",
    label: "Required sections present",
    passed: missingSections.length === 0,
    detail:
      missingSections.length === 0
        ? `All ${criteria.requiredSections.length} required sections found`
        : `Missing: ${missingSections.join(", ")}`,
  });

  const wordCount = words(content);
  checks.push({
    id: "min_words",
    label: "Minimum word count",
    passed: wordCount >= criteria.minWords,
    detail: `${wordCount} words (minimum ${criteria.minWords})`,
  });

  const citations = urls(content);
  checks.push({
    id: "min_citations",
    label: "Minimum distinct citations",
    passed: citations.length >= criteria.minCitations,
    detail: `${citations.length} distinct URLs (minimum ${criteria.minCitations})`,
  });

  const lower = normalize(content);
  const missingTerms = criteria.mustMention.filter((term) => !lower.includes(normalize(term)));
  checks.push({
    id: "must_mention",
    label: "Required terms mentioned",
    passed: missingTerms.length === 0,
    detail: missingTerms.length === 0 ? "All required terms present" : `Missing: ${missingTerms.join(", ")}`,
  });

  const allCanaries = [...new Set([...BUILT_IN_CANARIES, ...criteria.forbiddenPhrases.map(normalize)])];
  const foundCanaries = allCanaries.filter((phrase) => phrase && lower.includes(phrase));
  const instructionPattern =
    /\b(ignore|disregard|override)\b[^.\n]{0,80}\b(criteria|instructions?|reviewer|grader|system)\b/i;
  const returnPassPattern = /\b(return|respond with|output)\b[^.\n]{0,40}\bpass\b/i;
  const patternHit = instructionPattern.test(content) || returnPassPattern.test(content);
  checks.push({
    id: "no_reviewer_instructions",
    label: "No instructions addressed to the reviewer",
    passed: foundCanaries.length === 0 && !patternHit,
    detail:
      foundCanaries.length === 0 && !patternHit
        ? "No reviewer-directed instructions detected"
        : `Detected: ${[...foundCanaries, ...(patternHit ? ["instruction pattern"] : [])].join(", ")}`,
  });

  const placeholderPattern = /\b(lorem ipsum|todo|tbd|placeholder|\[insert[^\]]*\])\b/i;
  const placeholder = placeholderPattern.test(content);
  checks.push({
    id: "no_placeholders",
    label: "No placeholder text",
    passed: !placeholder,
    detail: placeholder ? "Placeholder text detected" : "No placeholder text detected",
  });

  return checks;
}

export function combineVerdict(
  checks: DeterministicCheck[],
  serv: ServVerdict | null,
  confidenceThreshold = 0.6,
): CombinedVerdict {
  const failed = checks.filter((check) => !check.passed);
  if (failed.length > 0) {
    return {
      decision: "fail",
      reason: `Deterministic checks failed: ${failed.map((check) => check.label).join(", ")}`,
      deterministic: checks,
      serv,
      threshold: confidenceThreshold,
    };
  }
  if (!serv) {
    return {
      decision: "fail",
      reason: "No independent verdict was produced; funds are held.",
      deterministic: checks,
      serv: null,
      threshold: confidenceThreshold,
    };
  }
  if (serv.decision === "fail") {
    return {
      decision: "fail",
      reason: `SERV failed the artifact: ${serv.summary}`,
      deterministic: checks,
      serv,
      threshold: confidenceThreshold,
    };
  }
  const failedCriteria = serv.criteria.filter((criterion) => !criterion.passed);
  if (failedCriteria.length > 0) {
    return {
      decision: "fail",
      reason: `SERV passed the overall artifact but failed ${failedCriteria.length} criterion/criteria: ${failedCriteria
        .map((criterion) => criterion.criterion)
        .join("; ")}`,
      deterministic: checks,
      serv,
      threshold: confidenceThreshold,
    };
  }
  if (serv.confidence < confidenceThreshold) {
    return {
      decision: "fail",
      reason: `SERV confidence ${serv.confidence.toFixed(2)} is below the ${confidenceThreshold.toFixed(2)} release threshold; the seller may appeal.`,
      deterministic: checks,
      serv,
      threshold: confidenceThreshold,
    };
  }
  return {
    decision: "pass",
    reason: `All deterministic checks passed and SERV accepted the artifact with ${(serv.confidence * 100).toFixed(0)}% confidence.`,
    deterministic: checks,
    serv,
    threshold: confidenceThreshold,
  };
}
