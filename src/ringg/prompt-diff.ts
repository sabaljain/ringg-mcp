/**
 * What a prompt write actually changed, reported at the level people edit at.
 *
 * A prompt section is long - several thousand characters of HTML - so "section Task was
 * updated" says almost nothing, and echoing the whole before and after says too much to
 * read. Sections are built from numbered steps under `<h3>` headings ("2. NEED
 * EXPLORATION"), which is the unit an author actually thinks in, so the diff is reported
 * per step: which steps changed, and the text on each side of the change.
 *
 * Comparison is done on the plain-text rendering, not the HTML. Re-saving a section
 * through the dashboard editor rewrites markup without touching a word, and reporting
 * that as a change would train the reader to ignore the report.
 */

import { stripHtml } from "./prompt-refs.js";

export interface StepChange {
  /** Heading the step sits under, or "(section opening)" for text before the first one. */
  step: string;
  status: "added" | "removed" | "changed";
  before?: string;
  after?: string;
}

export interface SectionChange {
  section_title: string;
  status: "added" | "updated" | "unchanged" | "removed";
  chars_before: number;
  chars_after: number;
  /** Steps that differ. Empty when the section is unchanged, or changed only in markup. */
  steps: StepChange[];
  /** Set when the text is identical and only the underlying HTML moved. */
  note?: string;
}

interface Block {
  heading: string;
  text: string;
}

const OPENING = "(section opening)";

/** Collapses whitespace so indentation and markup reflow do not read as edits. */
function normalize(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** Splits a section into heading-delimited blocks, which is how steps are authored. */
function splitIntoBlocks(html: string): Block[] {
  const blocks: Block[] = [];
  let cursor = 0;
  let heading = OPENING;

  for (const match of html.matchAll(/<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/gi)) {
    const index = match.index ?? 0;
    blocks.push({ heading, text: normalize(stripHtml(html.slice(cursor, index))) });
    heading = normalize(stripHtml(match[1] ?? "")) || "(untitled heading)";
    cursor = index + match[0].length;
  }
  blocks.push({ heading, text: normalize(stripHtml(html.slice(cursor))) });

  return blocks.filter((b, i) => b.text !== "" || b.heading !== OPENING || i > 0);
}

function truncate(text: string, limit = 500): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}... [+${text.length - limit} more chars]`;
}

/** Characters shown either side of the edit, so it is readable in context. */
const CONTEXT = 110;

/**
 * Excerpts that show the edit rather than the opening of the step.
 *
 * A step can run to several thousand characters with the change buried in the middle;
 * quoting from the start would show two identical-looking excerpts. This trims the shared
 * prefix and suffix and windows both sides around what actually differs.
 */
function windowAroundDifference(before: string, after: string): { before: string; after: string } {
  const max = Math.min(before.length, after.length);
  let prefix = 0;
  while (prefix < max && before[prefix] === after[prefix]) prefix += 1;

  let suffix = 0;
  while (
    suffix < max - prefix &&
    before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
  ) {
    suffix += 1;
  }

  const start = Math.max(0, prefix - CONTEXT);
  const cut = (text: string) => {
    const end = Math.min(text.length, text.length - suffix + CONTEXT);
    const slice = text.slice(start, Math.max(end, start));
    return `${start > 0 ? "..." : ""}${truncate(slice)}${end < text.length ? "..." : ""}`;
  };

  return { before: cut(before), after: cut(after) };
}

/** Per-step differences between two versions of one section. */
export function diffSectionContent(beforeHtml: string, afterHtml: string): StepChange[] {
  const before = splitIntoBlocks(beforeHtml);
  const after = splitIntoBlocks(afterHtml);

  const beforeByHeading = new Map<string, string>();
  for (const block of before) beforeByHeading.set(block.heading, block.text);
  const afterByHeading = new Map<string, string>();
  for (const block of after) afterByHeading.set(block.heading, block.text);

  const changes: StepChange[] = [];

  // Walk the new order first, so the report reads in document order.
  for (const block of after) {
    const previous = beforeByHeading.get(block.heading);
    if (previous === undefined) {
      changes.push({ step: block.heading, status: "added", after: truncate(block.text) });
    } else if (previous !== block.text) {
      const window = windowAroundDifference(previous, block.text);
      changes.push({
        step: block.heading,
        status: "changed",
        before: window.before,
        after: window.after,
      });
    }
  }
  for (const block of before) {
    if (!afterByHeading.has(block.heading)) {
      changes.push({ step: block.heading, status: "removed", before: truncate(block.text) });
    }
  }

  return changes;
}

/**
 * The full change report for a write.
 *
 * `before` is the section list read from the agent; `after` is what will be sent. Both
 * are keyed by title the same way the merge is, so the report and the write agree on
 * what counts as the same section.
 */
export function buildChangeReport(
  before: Array<{ section_title: string; section_content: string }>,
  after: Array<{ section_title: string; section_content: string }>,
): SectionChange[] {
  const key = (title: string) => title.trim().toLowerCase();
  const beforeByTitle = new Map(before.map((s) => [key(s.section_title), s]));
  const afterByTitle = new Map(after.map((s) => [key(s.section_title), s]));
  const report: SectionChange[] = [];

  for (const section of after) {
    const previous = beforeByTitle.get(key(section.section_title));
    if (!previous) {
      report.push({
        section_title: section.section_title,
        status: "added",
        chars_before: 0,
        chars_after: section.section_content.length,
        steps: diffSectionContent("", section.section_content),
      });
      continue;
    }

    const identicalHtml = previous.section_content === section.section_content;
    const steps = identicalHtml
      ? []
      : diffSectionContent(previous.section_content, section.section_content);
    const textIdentical = steps.length === 0;

    report.push({
      section_title: section.section_title,
      status: textIdentical ? "unchanged" : "updated",
      chars_before: previous.section_content.length,
      chars_after: section.section_content.length,
      steps,
      ...(textIdentical && !identicalHtml
        ? { note: "Markup changed but the wording is identical - nothing the agent says is affected." }
        : {}),
    });
  }

  for (const section of before) {
    if (afterByTitle.has(key(section.section_title))) continue;
    report.push({
      section_title: section.section_title,
      status: "removed",
      chars_before: section.section_content.length,
      chars_after: 0,
      steps: [],
    });
  }

  return report;
}

/** One-line summary of the report, so the headline does not have to be reconstructed. */
export function summarizeChangeReport(report: SectionChange[]): string {
  const counts = { added: 0, updated: 0, removed: 0, unchanged: 0 };
  let steps = 0;
  for (const section of report) {
    counts[section.status] += 1;
    steps += section.steps.length;
  }
  const parts: string[] = [];
  if (counts.updated) parts.push(`${counts.updated} section(s) updated`);
  if (counts.added) parts.push(`${counts.added} added`);
  if (counts.removed) parts.push(`${counts.removed} removed`);
  if (counts.unchanged) parts.push(`${counts.unchanged} unchanged`);
  const stepPart = steps > 0 ? `, ${steps} step(s) changed` : ", no wording changed";
  return `${parts.join(", ") || "no sections"}${stepPart}.`;
}
